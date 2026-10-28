// content/content.js
// 三重职责：
// 1. 检测 <video> 标签的 currentSrc，捕获 webRequest 可能遗漏的流地址
// 2. 受控注入 inject.js 到页面 MAIN world，拦截快手弹幕 WebSocket
// 3. 将 inject.js 拦截的弹幕事件转发给 background.js
//
// 注意：content_scripts 不支持 ESM，不能使用 import，必要函数直接内联

const TAG = '[Content]';

// ========== 安全通信包装（避免扩展重载时报 Extension context invalidated）==========

function safeSendMessage(msg) {
  try {
    chrome.runtime.sendMessage(msg, () => {
      // 忽略响应，仅捕获 lastError
      if (chrome.runtime.lastError) {
        // 扩展上下文失效时静默忽略，不抛出
      }
    });
  } catch (e) {
    // 同步错误也静默忽略
  }
}

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
    safeSendMessage({
      action: 'add_media',
      url: video.currentSrc,
    });
  }
}

// 3 秒轮询：既是检测也是保活
setInterval(sniffVideo, 3000);

// ========== 2. 标签页健康检查（D3） ==========
//
// background 会周期性探测扩展自己打开的自动标签页，判断页面是否仍在正常
// 播放直播流。content_scripts 不支持 ESM（见文件头注释），因此无法 import
// lib/url.js，这里内联与 isKuaishouLiveRoomUrl 等价的最小实现。
//
// 关播浮层选择器保持"小且明确"：宁可漏判（交由 video 活跃性兜底），
// 也不要用模糊属性选择器造成误判，否则 background 会把正常直播页反复重载。
// 每个选择器还要求元素可见，进一步降低误判概率。
const END_OVERLAY_SELECTORS = [
  '.live-end-container', // 快手关播提示容器
  '.live-end-card', // 关播卡片
  '[data-testid="live-end"]', // 稳定的测试标识（若页面提供）
];

function normalizeUrlForCompare(url) {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.href.replace(/\/$/, '');
  } catch (_) {
    return '';
  }
}

function isElementVisible(el) {
  if (!el) return false;
  try {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  } catch (_) {
    return false;
  }
}

function hasActiveVideoElement() {
  const videos = document.querySelectorAll('video');
  for (const video of videos) {
    if (!video || video.ended) continue;
    // 任一 video 处于加载中/可播放状态，或已绑定有效 http 流地址，即视为活跃
    const ready = typeof video.readyState === 'number' && video.readyState >= 2;
    const validSrc = typeof video.currentSrc === 'string' && video.currentSrc.startsWith('http');
    if (ready || validSrc) return true;
  }
  return false;
}

function hasEndOverlayElement() {
  for (const selector of END_OVERLAY_SELECTORS) {
    let matched = [];
    try {
      matched = document.querySelectorAll(selector);
    } catch (_) {
      continue; // 非法选择器不应影响健康判定
    }
    for (const el of matched) {
      if (isElementVisible(el)) return true;
    }
  }
  return false;
}

/**
 * 构建健康检查结果
 * @param {string} [expectedRoomUrl] - background 记录的该标签页应指向的直播间
 * @returns {{isLiveRoom: boolean, hasActiveVideo: boolean, hasEndOverlay: boolean, healthy: boolean}}
 */
function buildHealthReport(expectedRoomUrl) {
  const isLiveRoom =
    isLiveRoomPage() &&
    (!expectedRoomUrl || normalizeUrlForCompare(expectedRoomUrl) === normalizeUrlForCompare(location.href));
  const hasActiveVideo = hasActiveVideoElement();
  const hasEndOverlay = hasEndOverlayElement();
  return {
    isLiveRoom,
    hasActiveVideo,
    hasEndOverlay,
    healthy: isLiveRoom && hasActiveVideo && !hasEndOverlay,
  };
}

// ========== 3. 弹幕采集状态 ==========

let danmakuInjected = false; // inject.js 是否已注入
let danmakuActive = false;   // 弹幕采集是否处于活跃状态（注入 + 转发）

// ========== 4. 注入弹幕拦截脚本 ==========

function injectDanmakuScript() {
  if (!isLiveRoomPage()) return;
  if (danmakuInjected) return; // 已注入，不重复

  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('content/inject.js');
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

// ========== 5. 弹幕事件转发 ==========

// 弹幕事件缓冲（每 3 秒批量发送一次，由前端聚合避免 SW 休眠问题）
let danmakuBuffer = [];
let flushTimer = null;
const FLUSH_INTERVAL_MS = 3000;
let danmakuSessionStartMs = 0;

/**
 * 将缓冲区的弹幕事件批量发送给 background.js
 */
function flushDanmakuBuffer() {
  if (danmakuBuffer.length === 0) return;

  const batch = danmakuBuffer.splice(0);
  safeSendMessage({
    action: 'danmaku_batch',
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
  safeSendMessage({
    action: 'danmaku_ready',
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
  safeSendMessage({
    action: 'danmaku_stop',
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
 *
 * 注意：content_scripts 不能 import lib/constants.js，
 * 这里沿用文件内既有的 action 字面量（与 ACTIONS 常量取值一致）。
 */
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'start_danmaku') {
    startDanmakuCollection();
  } else if (request.action === 'stop_danmaku') {
    stopDanmakuCollection();
  } else if (request.action === 'danmaku_health_check') {
    // 异步回复并保持消息通道，避免 background 侧拿到 undefined 而误判
    Promise.resolve()
      .then(() => sendResponse(buildHealthReport(request.roomUrl)))
      .catch(() => {});
    return true;
  }
});

// 页面卸载时刷新剩余缓冲
// 注意：必须用 safeSendMessage 而非裸 chrome.runtime.sendMessage，
// 否则扩展重载后旧页面残留的 content script 上下文已失效，
// 裸调用会同步抛 "Extension context invalidated"。
window.addEventListener('beforeunload', () => {
  if (danmakuActive) {
    flushDanmakuBuffer();
    safeSendMessage({
      action: 'danmaku_stop',
      url: location.href,
    });
  }
});

// ========== 6. 初始化：检查开关状态 ==========

chrome.storage.sync.get('danmakuEnabled', (result) => {
  if (result.danmakuEnabled === true) {
    startDanmakuCollection();
  } else {
    console.log(TAG, '弹幕采集开关关闭，等待启用');
  }
});
