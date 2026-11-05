// core/message-router.js
// 消息路由 — background onMessage 的唯一入口
// 将 chrome.runtime.onMessage.addListener 内部的 switch 逻辑完整提取为独立模块

import { ACTIONS, STORAGE_KEYS } from '../lib/constants.js';
import { getState } from './state.js';
import { finishRecording } from './badge.js';
import { getConfig } from './config.js';
import { handleContentStream } from './stream-detector.js';
import {
  startDanmakuSession,
  getDanmakuStatus,
  checkRecordingAndUpdateSession,
  handleDanmakuBatch,
  retryAllBufferingSessions,
  handleDanmakuStopFromContent,
} from './danmaku-session.js';
import { setDanmakuEnabled } from './danmaku-switch.js';
import { checkFollowingLivings, checkFollowingNow } from './following-poll.js';
import { getPollSchedule } from './poll-schedule.js';
import { handleXhsLiveInfo } from './xhs-live-discovery.js';
import { isSupportedLiveRoomUrl, normalizeRoomUrl } from '../lib/url.js';

function isXiaohongshuTabUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === 'xiaohongshu.com' ||
      host.endsWith('.xiaohongshu.com') ||
      host === 'redelight.cn' ||
      host.endsWith('.redelight.cn')
    );
  } catch (_) {
    return false;
  }
}

/**
 * 让所有已打开的小红书页面重新解析一次直播状态。
 * 用于配置保存 / Popup「立即检测」：inject 有发射去重，不重扫的话
 * 新增监控主播在已打开的直播间页面上不会立即生效。
 * content script 未注入（如扩展刚重载、页面未刷新）时静默跳过。
 */
async function rescanXhsTabs() {
  try {
    // redelight.cn 同样是小红书域名，manifest/content script 已覆盖，查询需保持一致
    const tabs = await chrome.tabs.query({
      url: ['*://*.xiaohongshu.com/*', '*://*.redelight.cn/*'],
    });
    let sent = 0;
    for (const tab of tabs) {
      if (!tab.id) continue;
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'xhs_rescan_room' });
        sent++;
      } catch (_) {}
    }
    return sent;
  } catch (_) {
    return 0;
  }
}

export function handleMessage(request, sender, sendResponse) {
  // ===== 来自 popup.js 的消息 =====

  if (request.action === ACTIONS.GET_DANMAKU_STATUS) {
    const sessions = getDanmakuStatus();
    getConfig().then((config) => {
      sendResponse({
        sessions,
        danmakuEnabled: config.danmakuEnabled ?? false,
      });
    });
    return true; // 保持异步通道
  }

  if (request.action === ACTIONS.CLEAR_COUNT) {
    getState().detectedStreams = [];
    // 清空列表是本轮状态重置：连同残留的录制中标记一起清，避免录制早已结束
    // 却仍显示 HIGH（徽章与 status_ 标记统一由 badge 模块管理）。
    finishRecording({ force: true }).catch(() => {});
    chrome.storage.local.set({ [STORAGE_KEYS.STREAMS]: [] }, () => {
      sendResponse({ status: 'cleared' });
    });
    return true;
  }

  if (request.action === ACTIONS.RETRY_DANMAKU_STATUS) {
    retryAllBufferingSessions()
      .then((result) => {
        sendResponse({ status: 'ok', ...result });
      })
      .catch((err) => {
        sendResponse({ status: 'error', message: err.message });
      });
    return true;
  }

  if (request.action === ACTIONS.TOGGLE_DANMAKU) {
    setDanmakuEnabled(request.enabled).then(() => {
      sendResponse({ status: 'ok', danmakuEnabled: request.enabled });
    });
    return true;
  }

  if (request.action === ACTIONS.TOGGLE_MONITOR) {
    if (request.enabled) {
      getState().notifiedRooms.clear();
      chrome.storage.local.remove('notifiedRooms');
      checkFollowingLivings();
    }
    sendResponse({ status: 'ok' });
    return;
  }

  if (request.action === ACTIONS.RECHECK_FOLLOWING) {
    getState().notifiedRooms.clear();
    chrome.storage.local.remove('notifiedRooms');
    checkFollowingLivings();
    // Options 保存后，让已打开的小红书直播间按新监控名单立即重扫。
    rescanXhsTabs();
    sendResponse({ status: 'recheck_started' });
    return;
  }

  // Popup「立即检测」：取消 interval → 立刻查一次 → 重新计时
  // 必须等查询有结果再回包，Popup 要据此展示本次结果。
  if (request.action === ACTIONS.CHECK_NOW) {
    checkFollowingNow()
      .then(async (result) => {
        const xhsTabs = await rescanXhsTabs();
        sendResponse({ status: 'ok', ...result, xhsTabs });
      })
      .catch((err) => {
        sendResponse({ status: 'error', message: err.message });
      });
    return true; // 保持异步通道
  }

  // Options 页展示「轮询间隔 + 下次请求时间」
  if (request.action === ACTIONS.GET_POLL_SCHEDULE) {
    getPollSchedule()
      .then((schedule) => sendResponse(schedule))
      .catch(() => sendResponse({ active: false }));
    return true;
  }

  // ===== 来自 content.js 的消息 =====
  // 兼容新旧两种消息格式（Message → action）

  const action =
    request.action ||
    {
      addMedia: ACTIONS.ADD_MEDIA,
      danmakuReady: ACTIONS.DANMAKU_READY,
      danmakuBatch: ACTIONS.DANMAKU_BATCH,
      danmakuStop: ACTIONS.DANMAKU_STOP,
    }[request.Message];

  if (action === ACTIONS.ADD_MEDIA) {
    const tab = sender.tab;
    if (!tab || !tab.title) return;
    const roomUrl = normalizeRoomUrl(tab.url);
    if (!isSupportedLiveRoomUrl(roomUrl)) return true;
    handleContentStream({ url: request.url, title: tab.title, roomUrl });
    return true;
  }

  if (action === ACTIONS.DANMAKU_READY) {
    const tab = sender.tab;
    const roomUrl = normalizeRoomUrl(request.url || tab?.url || '');
    if (!isSupportedLiveRoomUrl(roomUrl)) return;
    startDanmakuSession(
      roomUrl,
      request.sessionStartMs || Date.now(),
      tab?.id,
      request.url || roomUrl,
      request.title || tab?.title || ''
    );
    checkRecordingAndUpdateSession(roomUrl).catch((err) => {
      console.warn('[Danmaku] danmaku_ready 录制状态检查失败:', err.message);
    });
    return;
  }

  if (action === ACTIONS.DANMAKU_BATCH) {
    const tab = sender.tab;
    const roomUrl = normalizeRoomUrl(request.url || tab?.url || '');
    if (!isSupportedLiveRoomUrl(roomUrl)) return;
    handleDanmakuBatch(
      roomUrl,
      request.events,
      request.sessionStartMs,
      tab?.id,
      request.title || tab?.title || ''
    );
    return;
  }

  if (action === ACTIONS.DANMAKU_STOP) {
    const roomUrl = normalizeRoomUrl(request.url || sender.tab?.url || '');
    if (roomUrl) {
      // 恢复流程主动重载标签页时也会触发 unload → danmaku_stop。
      // 交给 danmaku-session 判定：扩展发起的重载忽略清理，
      // 真实离开（标签页已导航到别处）仍按原逻辑收尾。
      handleDanmakuStopFromContent(roomUrl, {
        senderTabUrl: sender.tab?.url,
      }).catch(() => {});
    }
    return;
  }

  if (action === ACTIONS.XHS_LIVE_INFO) {
    // 只接受来自小红书域名的 content script 消息：页面上的任意脚本都能
    // postMessage，若不在这一层校验来源，可被诱导向本地后端上报任意流地址。
    if (!isXiaohongshuTabUrl(sender.tab?.url)) {
      console.warn(
        '[XhsDiscovery] 忽略来源不可信的 xhs_live_info:',
        sender.tab?.url || '-'
      );
      return;
    }
    handleXhsLiveInfo(request.items).catch((err) => {
      console.warn('[XhsDiscovery] 处理页面直播信息失败:', err.message);
    });
    return;
  }
}
