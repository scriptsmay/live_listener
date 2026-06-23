// background.js — Service Worker 入口（纯胶水层）
// 职责：导入核心模块、恢复状态、注册事件监听

import { restoreState } from './core/state.js';
import { handleMessage } from './core/message-router.js';
import { handleWebRequest } from './core/stream-detector.js';
import { initAlarms } from './core/following-poll.js';
import { setDebugMode } from './lib/logger.js';

// 导入 recording.js 以注册 event-bus 监听器（STREAM_DETECTED → sendToEnvironments）
import './core/recording.js';

// 注册监听器（同步注册，确保 Service Worker 激活后立即生效）
chrome.webRequest.onBeforeRequest.addListener(handleWebRequest, {
  urls: ['<all_urls>'],
});
chrome.runtime.onMessage.addListener(handleMessage);

chrome.notifications.onClicked.addListener((notifId) => {
  if (!notifId.startsWith('notify_')) return;
  const roomId = notifId.replace('notify_', '');
  chrome.storage.local.get(`notify_${roomId}`, (result) => {
    const url =
      result[`notify_${roomId}`] ||
      'https://live.kuaishou.com/my-follow/living';
    chrome.tabs.create({ url });
  });
});

// 异步初始化：恢复状态 + 设置 alarm（避免 top-level await 导致 SW 注册失败）
(async () => {
  await restoreState();
  initAlarms();
  setDebugMode(false); // 后续可读取 storage 中的 debug 配置
  console.log('[Live Stream Sniffer] KS直播监测插件已启动');
})();

// 暴露调试接口（供 Service Worker Console 手动操作）
import { getState } from './core/state.js';
import { checkRecordingAndUpdateSession, getDanmakuStatus, retryAllBufferingSessions } from './core/danmaku-session.js';
self.__debug = {
  getState,
  getDanmakuStatus,
  checkRecordingAndUpdateSession,
  retryAllBufferingSessions,
};
