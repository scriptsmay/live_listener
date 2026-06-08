// content.js
// 三重职责：
// 1. 检测 <video> 标签的 currentSrc，捕获 webRequest 可能遗漏的流地址
// 2. 受控注入 inject.js 到页面 MAIN world，拦截快手弹幕 WebSocket
// 3. 将 inject.js 拦截的弹幕事件转发给 background.js

const TAG = '[Content]';

// ========== 1. 视频流地址嗅探（原有功能） ==========

function isLiveRoomPage() {
  return (
    location.hostname === 'live.kuaishou.com' &&
    /^\/u\/[^/?#]+/.test(location.pathname)
  );
}

function sniffVideo() {
  if (!isLiveRoomPage()) return;

  const video = document.querySelector('video');
  if (video && video.currentSrc && video.currentSrc.startsWith('http')) {
    chrome.runtime.sendMessage({
      Message: 'addMedia',
      url: video.currentSrc,
    });
  }
}

// 3 秒轮询：既是检测也是保活
setInterval(sniffVideo, 3000);

// ========== 2. 弹幕采集状态 ==========

let danmakuInjected = false; // inject.js 是否已注入
let danmakuActive = false;   // 弹幕采集是否处于活跃状态（注入 + 转发）

// ========== 3. 注入弹幕拦截脚本 ==========

function injectDanmakuScript() {
  if (!isLiveRoomPage()) return;
  if (danmakuInjected) return; // 已注入，不重复

  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('inject.js');
    script.onload = function () {
      console.log(TAG, 'inject.js 已注入到页面');
      danmakuInjected = true;
      this.remove(); // 注入后移除 script 标签（脚本已执行）
    };
    script.onerror = function () {
      console.error(TAG, 'inject.js 注入失败');
    };
    // 尽早插入到 DOM 中
    (document.head || document.documentElement).appendChild(script);
    console.log(TAG, '开始注入弹幕拦截脚本...');
  } catch (err) {
    console.error(TAG, '注入弹幕拦截脚本异常:', err);
  }
}

// ========== 4. 弹幕事件转发 ==========

// 弹幕事件缓冲（每 5 秒批量发送一次）
let danmakuBuffer = [];
let flushTimer = null;
const FLUSH_INTERVAL_MS = 5000;
let danmakuSessionStartMs = 0;

/**
 * 将缓冲区的弹幕事件批量发送给 background.js
 */
function flushDanmakuBuffer() {
  if (danmakuBuffer.length === 0) return;

  const batch = danmakuBuffer.splice(0);
  chrome.runtime.sendMessage({
    Message: 'danmakuBatch',
    events: batch,
    sessionStartMs: danmakuSessionStartMs,
    timestamp: Date.now(),
  });
}

/**
 * 启动定时刷新
 */
function startFlushTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushDanmakuBuffer();
  }, FLUSH_INTERVAL_MS);
}

/**
 * 停止定时刷新
 */
function stopFlushTimer() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

/**
 * 启动弹幕采集（注入脚本 + 开始转发）
 */
function startDanmakuCollection() {
  if (danmakuActive) return;
  danmakuActive = true;

  if (!danmakuInjected) {
    injectDanmakuScript();
  }

  danmakuSessionStartMs = Date.now();
  startFlushTimer();

  // 通知 background.js 弹幕采集已启动
  chrome.runtime.sendMessage({
    Message: 'danmakuReady',
    sessionStartMs: danmakuSessionStartMs,
    url: location.href,
    title: document.title,
  });

  console.log(TAG, '弹幕采集已启动');
}

/**
 * 停止弹幕采集（停止转发，但保留 inject.js 的 hook）
 */
function stopDanmakuCollection() {
  if (!danmakuActive) return;
  danmakuActive = false;

  stopFlushTimer();
  flushDanmakuBuffer(); // 刷新剩余缓冲

  // 通知 background.js 弹幕采集结束
  chrome.runtime.sendMessage({
    Message: 'danmakuStop',
    url: location.href,
  });

  console.log(TAG, '弹幕采集已停止');
}

/**
 * 监听来自 inject.js (MAIN world) 的 postMessage
 */
window.addEventListener('message', (event) => {
  // 只接受来自当前窗口的消息
  if (event.source !== window) return;

  const data = event.data;
  if (!data || data.source !== 'ks-danmaku-inject') return;

  // inject.js 注入成功通知
  if (data.type === 'danmaku_ready') {
    console.log(TAG, '弹幕拦截脚本已就绪');
    return;
  }

  // 弹幕事件（仅在采集活跃时接收）
  if (data.type === 'danmaku_events' && Array.isArray(data.events) && danmakuActive) {
    for (const evt of data.events) {
      if (evt && typeof evt === 'object') {
        danmakuBuffer.push(evt);
      }
    }
  }
});

/**
 * 监听来自 background.js 的弹幕采集控制指令
 */
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'start_danmaku') {
    startDanmakuCollection();
  } else if (request.action === 'stop_danmaku') {
    stopDanmakuCollection();
  }
});

// 页面卸载时刷新剩余缓冲
window.addEventListener('beforeunload', () => {
  if (danmakuActive) {
    flushDanmakuBuffer();
    chrome.runtime.sendMessage({
      Message: 'danmakuStop',
      url: location.href,
    });
  }
});

// ========== 5. 初始化：检查开关状态 ==========

chrome.storage.sync.get('danmakuEnabled', (result) => {
  if (result.danmakuEnabled === true) {
    startDanmakuCollection();
  } else {
    console.log(TAG, '弹幕采集开关关闭，等待启用');
  }
});
