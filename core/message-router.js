// core/message-router.js
// 消息路由 — background onMessage 的唯一入口
// 将 chrome.runtime.onMessage.addListener 内部的 switch 逻辑完整提取为独立模块

import { ACTIONS } from '../lib/constants.js';
import { getState } from './state.js';
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
import { isKuaishouLiveRoomUrl, normalizeRoomUrl } from '../lib/url.js';

export function handleMessage(request, sender, sendResponse) {
  // ===== 来自 popup.js 的消息 =====

  if (request.action === ACTIONS.GET_DANMAKU_STATUS) {
    const sessions = getDanmakuStatus();
    getConfig().then((config) => {
      sendResponse({ sessions, danmakuEnabled: config.danmakuEnabled ?? false });
    });
    return true; // 保持异步通道
  }

  if (request.action === ACTIONS.CLEAR_COUNT) {
    const s = getState();
    s.detectedStreams = [];
    chrome.action.setBadgeText({ text: '' });
    chrome.storage.local.set({ streams: [] }, () => {
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
    sendResponse({ status: 'recheck_started' });
    return;
  }

  // Popup「立即检测」：取消 interval → 立刻查一次 → 重新计时
  // 必须等查询有结果再回包，Popup 要据此展示本次结果。
  if (request.action === ACTIONS.CHECK_NOW) {
    checkFollowingNow()
      .then((result) => sendResponse({ status: 'ok', ...result }))
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
    { addMedia: ACTIONS.ADD_MEDIA, danmakuReady: ACTIONS.DANMAKU_READY,
      danmakuBatch: ACTIONS.DANMAKU_BATCH, danmakuStop: ACTIONS.DANMAKU_STOP }[request.Message];

  if (action === ACTIONS.ADD_MEDIA) {
    const tab = sender.tab;
    if (!tab || !tab.title) return;
    const roomUrl = normalizeRoomUrl(tab.url);
    if (!isKuaishouLiveRoomUrl(roomUrl)) return true;
    handleContentStream({ url: request.url, title: tab.title, roomUrl });
    return true;
  }

  if (action === ACTIONS.DANMAKU_READY) {
    const tab = sender.tab;
    const roomUrl = normalizeRoomUrl(tab?.url || '');
    if (!isKuaishouLiveRoomUrl(roomUrl)) return;
    startDanmakuSession(
      roomUrl,
      request.sessionStartMs || Date.now(),
      tab.id,
      request.url || roomUrl,
      request.title || tab.title || ''
    );
    checkRecordingAndUpdateSession(roomUrl).catch((err) => {
      console.warn('[Danmaku] danmaku_ready 录制状态检查失败:', err.message);
    });
    return;
  }

  if (action === ACTIONS.DANMAKU_BATCH) {
    const tab = sender.tab;
    const roomUrl = normalizeRoomUrl(tab?.url || '');
    if (!isKuaishouLiveRoomUrl(roomUrl)) return;
    handleDanmakuBatch(
      roomUrl,
      request.events,
      request.sessionStartMs,
      tab?.id,
      tab?.title || ''
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
}
