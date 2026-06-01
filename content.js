// content.js
// 三重职责：
// 1. 检测 <video> 标签的 currentSrc，捕获 webRequest 可能遗漏的流地址
// 2. 注入 inject.js 到页面 MAIN world，拦截快手弹幕 WebSocket
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

// ========== 2. 注入弹幕拦截脚本 ==========

function injectDanmakuScript() {
  if (!isLiveRoomPage()) return;

  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('inject.js');
    script.onload = function () {
      console.log(TAG, 'inject.js 已注入到页面');
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

// 立即注入（content.js 的 run_at: document_start）
injectDanmakuScript();

// ========== 3. 弹幕事件转发 ==========

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
    // 以当前时间为会话开始时间
    danmakuSessionStartMs = Date.now();
    startFlushTimer();
    // 通知 background.js 弹幕采集已启动
    chrome.runtime.sendMessage({
      Message: 'danmakuReady',
      sessionStartMs: danmakuSessionStartMs,
      url: location.href,
      title: document.title,
    });
    return;
  }

  // 弹幕事件
  if (data.type === 'danmaku_events' && Array.isArray(data.events)) {
    for (const evt of data.events) {
      if (evt && typeof evt === 'object') {
        danmakuBuffer.push(evt);
      }
    }
  }
});

// 页面卸载时刷新剩余缓冲
window.addEventListener('beforeunload', () => {
  flushDanmakuBuffer();
  // 通知 background.js 弹幕采集结束
  chrome.runtime.sendMessage({
    Message: 'danmakuStop',
    url: location.href,
  });
});
