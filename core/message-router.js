// core/message-router.js
// 消息路由 — background onMessage 的唯一入口
// 将 chrome.runtime.onMessage.addListener 内部的 switch 逻辑完整提取为独立模块

import { ACTIONS } from '../lib/constants.js';
import { getState } from './state.js';
import { getConfig } from './config.js';
import { handleContentStream } from './stream-detector.js';
import {
  startDanmakuSession,
  stopDanmakuSession,
  getDanmakuStatus,
  checkRecordingAndUpdateSession,
  handleDanmakuBatch,
} from './danmaku-session.js';
import { setDanmakuEnabled } from './danmaku-switch.js';
import { checkFollowingLivings } from './following-poll.js';
import { isKuaishouLiveRoomUrl } from '../lib/url.js';

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

  // ===== 来自 content.js 的消息 =====
  // 兼容新旧两种消息格式（Message → action）

  const action =
    request.action ||
    { addMedia: ACTIONS.ADD_MEDIA, danmakuReady: ACTIONS.DANMAKU_READY,
      danmakuBatch: ACTIONS.DANMAKU_BATCH, danmakuStop: ACTIONS.DANMAKU_STOP }[request.Message];

  if (action === ACTIONS.ADD_MEDIA) {
    const tab = sender.tab;
    if (!tab || !tab.title) return;
    if (!isKuaishouLiveRoomUrl(tab.url)) return true;
    handleContentStream({ url: request.url, title: tab.title, roomUrl: tab.url });
    return true;
  }

  if (action === ACTIONS.DANMAKU_READY) {
    const tab = sender.tab;
    const roomUrl = tab?.url || '';
    if (!isKuaishouLiveRoomUrl(roomUrl)) return;
    startDanmakuSession(
      roomUrl,
      request.sessionStartMs || Date.now(),
      tab.id,
      request.url || roomUrl,
      request.title || tab.title || ''
    );
    checkRecordingAndUpdateSession(roomUrl).catch(() => {});
    return;
  }

  if (action === ACTIONS.DANMAKU_BATCH) {
    const tab = sender.tab;
    const roomUrl = tab?.url || '';
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
    const roomUrl = request.url || sender.tab?.url || '';
    if (roomUrl) stopDanmakuSession(roomUrl, true).catch(() => {});
    return;
  }
}
