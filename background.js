import {
  QUALITY_WEIGHTS,
  LIVING_API_URL,
  POLL_INTERVAL_MINUTES,
  getConfig,
  DANMAKU_BATCH_API_PATH,
} from './config.js';
import {
  normalizeDanmakuBatch,
  filterDanmakuEvents,
} from './danmaku-parser.js';

const MAX_DETECTED_STREAMS = 100;
const REQUEST_TIMEOUT_MS = 8000;

let lastUrl = ''; // 简单防抖：防止同一地址短时间内多次弹出

// 检测到的直播流，应该是一个对象，包含 url、title、roomUrl 等信息，方便后续扩展
let detectedStreams = [];
const bestStreamsByRoom = new Map();
let activeRecordingRoomUrl = null;

// ========== 弹幕采集状态 ==========
const danmakuSessions = new Map(); // roomUrl -> { sessionStartMs, eventCount, tabId, url, title, isSending, lastRecordingCheckAt }
const danmakuBatchBuffer = new Map(); // roomUrl -> events[]
const autoOpenedTabs = new Map(); // roomUrl -> tabId（扩展自动打开的弹幕采集标签页）
const DANMAKU_BATCH_FLUSH_MS = 5000; // 5秒刷新一次
const RECORDING_CHECK_INTERVAL_MS = 10000; // 10秒检查一次录制状态
const DANMAKU_MAX_BUFFER_SIZE = 5000; // 缓冲区最大事件数（防止内存泄漏）

/**
 * 录制确认后自动打开后台标签页，确保弹幕采集脚本能注入
 * 如果该房间已有打开的标签页（用户手动或之前自动打开的），不会重复创建
 */
async function ensureDanmakuTab(roomUrl) {
  // 如果已有自动打开的标签页记录，先验证是否还存在
  if (autoOpenedTabs.has(roomUrl)) {
    const existingTabId = autoOpenedTabs.get(roomUrl);
    try {
      await chrome.tabs.get(existingTabId);
      return; // 标签页仍存在，无需重复打开
    } catch (_) {
      autoOpenedTabs.delete(roomUrl); // 已关闭，清理记录
    }
  }

  try {
    const tab = await chrome.tabs.create({ url: roomUrl, active: false });
    autoOpenedTabs.set(roomUrl, tab.id);
    console.log(`[Danmaku] 自动打开后台标签页: ${roomUrl} (tabId=${tab.id})`);
  } catch (err) {
    console.warn(`[Danmaku] 自动打开标签页失败: ${roomUrl}`, err.message);
  }
}

/**
 * 录制结束后自动关闭扩展打开的后台标签页
 * 用户手动打开的标签页不受影响
 */
async function closeAutoOpenedTab(roomUrl) {
  const tabId = autoOpenedTabs.get(roomUrl);
  if (tabId === undefined) return;

  autoOpenedTabs.delete(roomUrl);
  try {
    await chrome.tabs.remove(tabId);
    console.log(`[Danmaku] 录制结束，已关闭自动标签页: ${roomUrl} (tabId=${tabId})`);
  } catch (_) {
    // 标签页可能已被用户手动关闭
  }
}

/**
 * 启动弹幕会话（仅创建缓冲，不立即发送）
 * isSending 标记是否正在向后端发送弹幕（需录制中才开启）
 */
function startDanmakuSession(roomUrl, sessionStartMs, tabId, url, title) {
  danmakuSessions.set(roomUrl, {
    sessionStartMs,
    tabId,
    url,
    title,
    eventCount: 0,
    startedAt: Date.now(),
    isSending: false,
    stopping: false,
    lastRecordingCheckAt: 0,
  });
  danmakuBatchBuffer.set(roomUrl, []);
  console.log(`[Danmaku] 采集会话已创建（等待录制）: ${roomUrl}`);
}

/**
 * 停止弹幕会话（先 drain 缓冲再 flush，最后清理）
 * @param {string} roomUrl - 直播间 URL
 * @param {boolean} forceFlush - 强制刷新剩余缓冲（录制结束时使用）
 */
async function stopDanmakuSession(roomUrl, forceFlush = false) {
  const session = danmakuSessions.get(roomUrl);
  if (session) {
    console.log(`[Danmaku] 采集会话结束: ${roomUrl}, 共 ${session.eventCount} 条事件`);
    // 1. 标记停止，阻止后续事件进入缓冲
    session.stopping = true;

    // 2. 同步取出缓冲区内容（防止 drain 期间新事件丢失）
    const buffer = danmakuBatchBuffer.get(roomUrl);
    const remaining = buffer ? buffer.splice(0) : [];
    session.eventCount += remaining.length;

    // 3. 如需刷新，先恢复事件到缓冲区再 await flush
    if (forceFlush && session.isSending && remaining.length > 0) {
      buffer.push(...remaining);
      await flushDanmakuBatch(roomUrl).catch(() => {});
    }

    // 4. 从 Map 中移除
    danmakuSessions.delete(roomUrl);
    danmakuBatchBuffer.delete(roomUrl);
  } else {
    danmakuSessions.delete(roomUrl);
    danmakuBatchBuffer.delete(roomUrl);
  }
}

/**
 * 检查指定房间的录制状态，并自动启停弹幕发送
 * @returns {Promise<boolean>} 当前是否正在发送
 */
async function checkRecordingAndUpdateSession(roomUrl) {
  const session = danmakuSessions.get(roomUrl);
  if (!session) return false;

  session.lastRecordingCheckAt = Date.now();

  const config = await getConfig();
  let isRecording = false;
  for (const env of config.environments) {
    if (!env.enabled) continue;
    try {
      if (await isEnvironmentRecording(env, roomUrl)) {
        isRecording = true;
        break;
      }
    } catch (_) {}
  }

  if (isRecording && !session.isSending) {
    // 录制开始 → 开启发送
    session.isSending = true;
    console.log(`[Danmaku] 录制中，开始发送弹幕: ${roomUrl}`);
  } else if (!isRecording && session.isSending) {
    // 录制结束 → 先刷新剩余缓冲，再关闭发送，最后关闭自动打开的标签页
    console.log(`[Danmaku] 录制已结束，停止发送弹幕: ${roomUrl}`);
    await flushDanmakuBatch(roomUrl).catch(() => {});
    session.isSending = false;
    await closeAutoOpenedTab(roomUrl);
  }

  // 网络 await 期间会话可能已被 stop，重新检查
  if (!danmakuSessions.has(roomUrl)) return false;
  return session.isSending;
}

/**
 * 刷新指定房间的弹幕缓冲到后端
 * 仅在 isSending=true 时才实际发送，否则保留在缓冲区
 */
async function flushDanmakuBatch(roomUrl) {
  const buffer = danmakuBatchBuffer.get(roomUrl);
  const session = danmakuSessions.get(roomUrl);
  if (!buffer || buffer.length === 0 || !session) return;
  if (!session.isSending) return; // 未在录制，保留缓冲不发送

  const events = buffer.splice(0);
  session.eventCount += events.length;

  // 标准化事件
  const normalized = normalizeDanmakuBatch(events, session.sessionStartMs);

  // 过滤（暂不支持屏蔽词，后续可扩展）
  const filtered = filterDanmakuEvents(normalized, { includeLikes: false });

  if (filtered.length === 0) return;

  // 发送到所有启用环境的后端
  try {
    const config = await getConfig();
    for (const env of config.environments) {
      if (!env.enabled) continue;
      try {
        await fetchJson(env.danmakuBatchApiUrl || `${env.baseUrl}${DANMAKU_BATCH_API_PATH}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            room_url: roomUrl,
            events: filtered,
            session_start_ms: session.sessionStartMs,
            title: session.title || '',
          }),
        });
      } catch (err) {
        console.warn(`[Danmaku] 批量发送到 ${env.name} 失败:`, err.message);
      }
    }
  } catch (err) {
    console.warn('[Danmaku] 批量发送失败:', err.message);
  }
}

/**
 * 定时刷新弹幕缓冲 + 周期性检查录制状态
 */
setInterval(async () => {
  for (const roomUrl of danmakuBatchBuffer.keys()) {
    const session = danmakuSessions.get(roomUrl);
    // 定期检查录制状态，自动启停发送
    if (session && Date.now() - session.lastRecordingCheckAt > RECORDING_CHECK_INTERVAL_MS) {
      await checkRecordingAndUpdateSession(roomUrl).catch(() => {});
    }
    flushDanmakuBatch(roomUrl).catch(() => {});
  }
}, DANMAKU_BATCH_FLUSH_MS);

console.log('[Live Stream Sniffer]KS直播监测插件已启动');

function getEnvAuthors(env) {
  return Array.isArray(env.followedAuthors) ? env.followedAuthors : [];
}

function getEnabledEnvironments(config) {
  return config.environments.filter((env) => env.enabled);
}

function findEnvironmentsByTitle(config, title) {
  return getEnabledEnvironments(config).filter((env) =>
    getEnvAuthors(env).some((author) => title.includes(author))
  );
}

function isKuaishouLiveRoomUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === 'live.kuaishou.com' &&
      /^\/u\/[^/?#]+/.test(parsed.pathname)
    );
  } catch (_) {
    return false;
  }
}

function getLiveRoomUrlFromRequest(details, tab) {
  return [details.documentUrl, tab?.url].find((url) =>
    isKuaishouLiveRoomUrl(url)
  );
}

function getQualityWeight(url) {
  for (let key in QUALITY_WEIGHTS) {
    if (url.includes(key)) return QUALITY_WEIGHTS[key];
  }
  return 0;
}

function addDetectedStream(stream) {
  detectedStreams = [...detectedStreams, stream].slice(-MAX_DETECTED_STREAMS);
  chrome.action.setBadgeText({ text: detectedStreams.length.toString() });
  chrome.action.setBadgeBackgroundColor({ color: '#ff5000' });
  chrome.storage.local.set({ streams: detectedStreams });
}

/**
 * 录制请求成功后，立即激活该房间的弹幕发送
 * 跳过等待录制状态轮询，消除最多 10 秒的发送延迟
 */
function activateDanmakuForRoom(roomUrl) {
  const session = danmakuSessions.get(roomUrl);
  if (!session || session.isSending || session.stopping) return;
  session.isSending = true;
  console.log(`[Danmaku] 录制请求已确认，立即开启弹幕发送: ${roomUrl}`);
}

/**
 * 录制被后端拒绝时，停止该房间的弹幕发送
 * 配合 closeAutoOpenedTab 一起清理，使会话回到缓冲模式
 */
function deactivateDanmakuForRoom(roomUrl) {
  const session = danmakuSessions.get(roomUrl);
  if (!session || !session.isSending) return;
  session.isSending = false;
  console.log(`[Danmaku] 录制被拒绝，停止弹幕发送: ${roomUrl}`);
}

function setActiveRecordingRoom(roomUrl) {
  activeRecordingRoomUrl = roomUrl;
  chrome.storage.local.set({ activeRecordingRoomUrl });
}

function clearActiveRecordingRoom() {
  activeRecordingRoomUrl = null;
  chrome.storage.local.remove('activeRecordingRoomUrl');
}

async function fetchJson(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const text = await resp.text();
    let data = null;

    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_) {
        data = { raw: text };
      }
    }

    return {
      ok: resp.ok,
      status: resp.status,
      data,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function isEnvironmentRecording(env, roomUrl) {
  const result = await fetchJson(
    `${env.statusApiUrl}?url=${encodeURIComponent(roomUrl)}`
  );
  const data = result.data || {};

  return (
    result.ok &&
    data.exists &&
    (data.data?.status === 'recording' || data.data?.status === 'paused')
  );
}

async function sendToEnvironments(environments, url, title, roomUrl, caption = '') {
  let activeCount = 0;

  for (const env of environments) {
    if (!env.enabled) continue;

    // 先查后端状态，已在录制则跳过
    let alreadyRecording = false;
    try {
      if (await isEnvironmentRecording(env, roomUrl)) {
        console.log(
          `[Live Stream Sniffer][${env.name}] 已在录制中，跳过: ${roomUrl}`
        );
        setActiveRecordingRoom(roomUrl);
        activateDanmakuForRoom(roomUrl);
        ensureDanmakuTab(roomUrl);
        activeCount++;
        alreadyRecording = true;
      }
    } catch (err) {
      console.warn(`[Live Stream Sniffer][${env.name}] 状态查询失败:`, err);
    }

    if (alreadyRecording) continue;

    // 未在录制，发送录制请求
    try {
      const result = await fetchJson(env.notifyApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          title: `${title}`,
          room_url: roomUrl,
          caption,
        }),
      });
      if (result.ok) {
        setActiveRecordingRoom(roomUrl);
        activateDanmakuForRoom(roomUrl);
        ensureDanmakuTab(roomUrl);
        activeCount++;
        console.log(
          `[Live Stream Sniffer][${env.name}] 录制请求成功: ${roomUrl}`
        );
      } else if (result.data) {
        // 后端拒绝录制（如 400 暂停监听）
        const rejectionMsg =
          result.data?.message ||
          result.data?.status ||
          `HTTP ${result.status}`;
        console.warn(
          `[Live Stream Sniffer][${env.name}] 录制被拒绝: ${rejectionMsg}`
        );
        // 清理该房间的录制相关状态
        closeAutoOpenedTab(roomUrl);
        deactivateDanmakuForRoom(roomUrl);
        // 通知 Popup 清除过期的录制中标记
        chrome.runtime.sendMessage({
          action: 'recording_rejected',
          roomUrl,
          streamUrl: url,
          message: rejectionMsg,
        }).catch(() => {});
      }
      console.log(
        `[DEBUG][${env.name}] response:`,
        JSON.stringify(result.data)
      );
    } catch (err) {
      console.warn(`[Live Stream Sniffer][${env.name}] 发送录制请求失败:`, err);
    }
  }

  if (activeCount > 0) {
    chrome.action.setBadgeText({ text: 'HIGH' });
    chrome.storage.local.set({ [`status_${url}`]: 'auto-recorded' });
  }
}

async function sendToBackend(url, title, roomUrl, caption = '') {
  const config = await getConfig();
  await sendToEnvironments(
    getEnabledEnvironments(config),
    url,
    title,
    roomUrl,
    caption
  );
}

/**
 * 自动选择最佳清晰度的视频下载地址并发送给后端
 */
function autoChooseBest(details, targetEnvs, roomUrl, title) {
  if (!isKuaishouLiveRoomUrl(roomUrl)) return;

  const key = roomUrl;
  const weight = getQualityWeight(details.url);
  const state = bestStreamsByRoom.get(key) || {
    timer: null,
    bestUrl: '',
    currentBestLevel: -1,
    title,
    targetEnvs,
  };

  state.title = title;
  state.targetEnvs = targetEnvs;

  // 如果这个流比刚才抓到的更清晰，则更新
  if (weight > state.currentBestLevel) {
    state.currentBestLevel = weight;
    state.bestUrl = details.url;
    console.log(`🚀 发现更优画质 (${weight}):`, details.url);
  }

  // --- 延迟 2 秒发送，等待所有潜在的清晰度流都冒出来 ---
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    if (state.bestUrl) {
      sendToEnvironments(state.targetEnvs, state.bestUrl, state.title, roomUrl);
    }
    bestStreamsByRoom.delete(key);
  }, 2000);

  bestStreamsByRoom.set(key, state);
}

// 标记是否访问过快手页面（前置条件：有 cookie 才能调 API）
function markKuaishouVisited(url) {
  if (
    url.includes('.kuaishou.com') &&
    !url.includes('log') &&
    !url.includes('stat')
  ) {
    chrome.storage.local.set({ kuaishouVisited: true });
  }
}

function getTabInfo(tabId) {
  return new Promise((resolve) => {
    // 使用 tabId 获取标签页的详细信息
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        // 处理可能的错误，比如标签页在请求完成前被关闭
        console.error(
          `获取标签页 ${tabId} 失败: ${chrome.runtime.lastError.message}`
        );
        return resolve(null);
      }
      // console.log('标签页 URL:', tab.url);
      // console.log('页面标题:', tab.title);
      resolve(tab);
    });
  });
}

chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    markKuaishouVisited(details.url);

    // 2. 只要包含 .flv 且 URL 还没被处理过就拦截
    if (details.url.includes('.flv') && details.url !== lastUrl) {
      // 排除掉一些可能的干扰项（可选）
      if (details.url.includes('log') || details.url.includes('stat')) {
        // 有些监控请求可能带 flv 字样但不是视频流
        // console.log('排除干扰项:', details.url);
        // return;
      }

      // 获取当前tab的 url 作为直播间地址 roomUrl，后续发送给后端用于匹配和展示
      if (details.tabId === -1) {
        console.log('此请求不关联任何标签页，跳过处理。');
        return;
      }
      const tab = await getTabInfo(details.tabId);
      if (!tab) {
        console.log('无法获取标签页信息，跳过处理。');
        return;
      }
      const roomUrl = getLiveRoomUrlFromRequest(details, tab) || '';
      if (!isKuaishouLiveRoomUrl(roomUrl)) {
        console.log('非直播间页面捕获到流请求，跳过:', roomUrl);
        return;
      }
      lastUrl = details.url;

      const title = tab.title;

      const detectedInfo = {
        url: details.url,
        title,
        roomUrl,
        capturedAt: Date.now(),
      };
      addDetectedStream(detectedInfo);
      console.log(
        '✅ 捕获到直播流地址:',
        details.url,
        '| 直播间 URL:',
        roomUrl,
        '标题:',
        title
      );
      // 2. 获取该标签页的信息
      const tabId = details.tabId;
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab || !tab.title) return;

        // 3. 按环境匹配关注列表中的主播
        getConfig().then((config) => {
          const targetEnvs = findEnvironmentsByTitle(config, tab.title);
          if (targetEnvs.length) {
            console.log(
              `🎯 匹配到目标直播间: ${tab.title}，准备自动录制到 ${targetEnvs
                .map((env) => env.name)
                .join(', ')}`
            );
            autoChooseBest(details, targetEnvs, roomUrl, title);
          }
        });
      });
    }
  },
  // 3. 这里的 urls 过滤也要同步扩大
  { urls: ['<all_urls>'] }
);

// 监听来自 Popup or Options 的指令
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 弹幕采集状态查询（Popup 使用）
  if (request.action === 'get_danmaku_status') {
    const sessions = [];
    for (const [roomUrl, session] of danmakuSessions) {
      const buffer = danmakuBatchBuffer.get(roomUrl) || [];
      sessions.push({
        roomUrl,
        title: session.title || '',
        isSending: session.isSending,
        stopping: session.stopping,
        eventCount: session.eventCount,
        bufferSize: buffer.length,
        startedAt: session.startedAt,
        sessionStartMs: session.sessionStartMs,
        hasAutoTab: autoOpenedTabs.has(roomUrl),
      });
    }
    sendResponse({ sessions });
    return;
  }

  if (request.action === 'clear_count') {
    console.log('收到清空指令');

    // 1. 清空内存中的数组
    detectedStreams = [];

    // 2. 清空图标上的数字
    chrome.action.setBadgeText({ text: '' });

    // 3. 彻底清空持久化存储
    chrome.storage.local.set({ streams: [] }, () => {
      console.log('存储已清空');
      sendResponse({ status: 'cleared' });
    });

    return true; // 保持异步消息通道开启
  }

  if (request.action === 'recheck_following') {
    // 配置更新后立即重新检测
    notifiedRooms.clear();
    chrome.storage.local.remove('notifiedRooms');
    checkFollowingLivings();
    sendResponse({ status: 'recheck_started' });
  }

  if (request.action === 'toggle_monitor') {
    if (request.enabled) {
      notifiedRooms.clear();
      chrome.storage.local.remove('notifiedRooms');
      checkFollowingLivings();
    }
    sendResponse({ status: 'ok' });
  }

  // 来自 content.js 的视频流检测（同时起到 MV3 心跳保活作用）
  if (request.Message === 'addMedia' && request.url) {
    const url = request.url;
    const tab = sender.tab;
    if (!tab || !tab.title) return;
    if (!isKuaishouLiveRoomUrl(tab.url)) {
      console.log('非直播间页面捕获到 video 地址，跳过:', tab.url);
      return true;
    }

    // 与 webRequest 捕获去重
    if (url === lastUrl) return;
    lastUrl = url;

    console.log('✅ [content] 捕获到直播流地址:', url);
    addDetectedStream({
      url,
      title: tab.title,
      roomUrl: tab.url,
      capturedAt: Date.now(),
    });

    // 按环境匹配关注列表中的主播
    getConfig().then((config) => {
      const targetEnvs = findEnvironmentsByTitle(config, tab.title);
      if (targetEnvs.length) {
        console.log(
          `🎯 [content] 匹配到目标直播间: ${tab.title}，发送到 ${targetEnvs
            .map((env) => env.name)
            .join(', ')}`
        );
        // video.currentSrc 已是页面选好的清晰度，无需 quality 等待
        sendToEnvironments(targetEnvs, url, tab.title, tab.url);
      }
    });
    return true;
  }

  // ========== 弹幕采集消息处理 ==========

  // 弹幕拦截脚本就绪通知
  if (request.Message === 'danmakuReady') {
    const tab = sender.tab;
    const roomUrl = tab?.url || '';
    if (!isKuaishouLiveRoomUrl(roomUrl)) return;

    // 创建弹幕会话（缓冲模式，不立即发送）
    startDanmakuSession(
      roomUrl,
      request.sessionStartMs || Date.now(),
      tab.id,
      request.url || roomUrl,
      request.title || tab.title || ''
    );

    // 立即检查录制状态，如果已在录制中则马上开启发送
    checkRecordingAndUpdateSession(roomUrl).catch(() => {});
    return;
  }

  // 弹幕批量事件
  if (request.Message === 'danmakuBatch') {
    const tab = sender.tab;
    const roomUrl = tab?.url || '';
    if (!isKuaishouLiveRoomUrl(roomUrl)) return;

    // 如果会话不存在，自动创建
    if (!danmakuSessions.has(roomUrl)) {
      startDanmakuSession(
        roomUrl,
        request.sessionStartMs || Date.now(),
        tab.id,
        roomUrl,
        tab.title || ''
      );
      // 尝试检查录制状态并开启发送
      checkRecordingAndUpdateSession(roomUrl).catch(() => {});
    }

    const session = danmakuSessions.get(roomUrl);
    const buffer = danmakuBatchBuffer.get(roomUrl);
    // 跳过正在停止的会话；限制缓冲区大小防止内存泄漏
    if (session?.stopping) return;
    if (buffer && Array.isArray(request.events)) {
      buffer.push(...request.events);
      // 防止缓冲区无限增长：超出上限时丢弃最早的事件
      if (buffer.length > DANMAKU_MAX_BUFFER_SIZE) {
        const dropped = buffer.length - DANMAKU_MAX_BUFFER_SIZE;
        buffer.splice(0, dropped);
        console.warn(`[Danmaku] 缓冲区溢出，丢弃 ${dropped} 条早期事件: ${roomUrl}`);
      }
    }
    return;
  }

  // 弹幕采集停止（页面卸载时触发）
  if (request.Message === 'danmakuStop') {
    const roomUrl = request.url || sender.tab?.url || '';
    if (roomUrl) {
      stopDanmakuSession(roomUrl, true).catch(() => {});
    }
    return;
  }
});

// ===== 轮询关注列表，检测开播 =====

const notifiedRooms = new Set();

// 在 SW 重启时，从本地存储恢复关键运行状态
chrome.storage.local.get(
  [
    'notifiedRooms',
    'streams',
    'activeRecordingRoomUrl',
    'activeRecordingByEnv',
  ],
  (result) => {
    if (result?.notifiedRooms) {
      for (const id of result.notifiedRooms) notifiedRooms.add(id);
    }
    if (Array.isArray(result?.streams)) {
      detectedStreams = result.streams.slice(-MAX_DETECTED_STREAMS);
      if (result.streams.length !== detectedStreams.length) {
        chrome.storage.local.set({ streams: detectedStreams });
      }
      if (detectedStreams.length) {
        chrome.action.setBadgeText({ text: detectedStreams.length.toString() });
        chrome.action.setBadgeBackgroundColor({ color: '#ff5000' });
      }
    }
    if (result?.activeRecordingRoomUrl) {
      activeRecordingRoomUrl = result.activeRecordingRoomUrl;
    } else if (result?.activeRecordingByEnv) {
      const active = Object.values(result.activeRecordingByEnv).find(
        (item) => item?.roomUrl
      );
      activeRecordingRoomUrl = active?.roomUrl || null;
      if (activeRecordingRoomUrl) {
        chrome.storage.local.set({ activeRecordingRoomUrl });
      }
      chrome.storage.local.remove('activeRecordingByEnv');
    }
  }
);

function pickBestQuality(representations) {
  let best = null;
  let bestLevel = -1;
  for (const rep of representations) {
    if ((rep.level || 0) > bestLevel) {
      bestLevel = rep.level;
      best = rep;
    }
  }
  console.log('Best quality:', bestLevel);
  return best?.url || representations[0]?.url || '';
}

async function handleStreamerOnline(
  author,
  roomId,
  playUrls,
  caption,
  targetEnvs
) {
  const roomUrl = `https://live.kuaishou.com/u/${author.id}`;

  let flvUrl = '';
  for (const p of playUrls) {
    if (p.adaptationSet?.representation?.length) {
      flvUrl = pickBestQuality(p.adaptationSet.representation);
      break;
    }
  }

  console.log(
    `主播 ${author.name} 开播了，直播间: ${roomUrl}, FLV地址: ${flvUrl}`
  );

  if (flvUrl) {
    console.log(
      `🎥 ${author.name} 自动发送直播流到 ${targetEnvs
        .map((env) => env.name)
        .join(', ')}`
    );
    sendToEnvironments(targetEnvs, flvUrl, author.name, roomUrl, caption);
  } else {
    // API 未返回流地址，打开直播间页面让 webRequest 捕获 + 启动弹幕采集
    console.log(
      `🌐 ${author.name} 无流地址，尝试打开直播间页面让 webRequest 捕获`
    );
    ensureDanmakuTab(roomUrl);
  }

  if (notifiedRooms.has(roomId)) return;
  notifiedRooms.add(roomId);
  chrome.storage.local.set({ notifiedRooms: [...notifiedRooms] });
  chrome.storage.local.set({ [`notify_${roomId}`]: roomUrl });

  chrome.notifications.create(`notify_${roomId}`, {
    type: 'basic',
    iconUrl: 'icon.png',
    title: `${author.name} 开播了！`,
    message: caption || '正在直播',
    contextMessage: '点击打开直播间',
    requireInteraction: true,
  });
}

function randomDelay(min, max) {
  return new Promise((resolve) =>
    setTimeout(resolve, Math.random() * (max - min) + min)
  );
}

/**
 * 存储上次请求关注列表的结果
 * @param {*} statusResult
 */
function setFollowReqStatus(statusResult) {
  chrome.storage.local.set({
    lastReqStatus: {
      time: Date.now(),
      result: statusResult,
    },
  });
}

/**
 * 检查关注的主播是否正在直播
 *
 * 该函数定期查询快手关注列表，检测已关注的主播是否开播。
 * 如果检测到关注的主播开播，会触发相应的录制处理逻辑。
 *
 * 优化策略：
 * - 如果当前目标直播间仍在任一环境录制中，跳过快手关注列表接口
 * - 添加随机延迟防止被风控
 * - 仅在访问过快手页面且配置了关注主播时才执行查询
 *
 * @async
 * @function checkFollowingLivings
 * @returns {Promise<void>} 无返回值，通过副作用处理检测结果
 *
 * @description
 * 执行流程：
 * 1. 检查监控是否启用，未启用则直接返回
 * 2. 如果已有录制中的目标直播间，检查各环境后端录制状态
 *    - 如果任一环境仍在录制中（recording或paused状态），跳过本次查询
 *    - 如果都不在录制中，清除录制标记，继续正常查询
 * 3. 检查是否访问过快手页面，未访问则返回
 * 4. 获取已启用环境的关注主播列表，为空则返回
 * 5. 添加2-6秒随机延迟，避免被风控
 * 6. 请求快手关注列表API，获取正在直播的主播
 * 7. 遍历直播列表，按环境匹配关注的主播，触发录制处理
 */
async function checkFollowingLivings() {
  try {
    const { monitorEnabled } = await chrome.storage.sync.get('monitorEnabled');
    if (monitorEnabled === false) return;

    const config = await getConfig();
    const enabledEnvs = getEnabledEnvironments(config);

    if (activeRecordingRoomUrl) {
      let anyRecording = false;
      for (const env of enabledEnvs) {
        try {
          if (await isEnvironmentRecording(env, activeRecordingRoomUrl)) {
            anyRecording = true;
            break;
          }
        } catch (err) {
          console.warn(`[Live Stream Sniffer][${env.name}] 录制状态查询失败:`, err);
        }
      }

      if (anyRecording) {
        console.log('[Live Stream Sniffer] 仍在录制中，跳过关注列表查询');
        return;
      }

      clearActiveRecordingRoom();
    }

    const { kuaishouVisited } =
      await chrome.storage.local.get('kuaishouVisited');
    if (!kuaishouVisited) return;

    const authors = new Set(
      enabledEnvs.flatMap((env) => getEnvAuthors(env))
    );
    if (!authors.size) return;

    // 随机延迟 2~6s，避免每次请求时间固定被风控
    await randomDelay(2000, 6000);

    console.log('[Live Stream Sniffer] 查询关注列表，检测开播中...');
    const result = await fetchJson(LIVING_API_URL, {
      credentials: 'include',
    });

    if (!result.ok) {
      console.warn(`[Live Stream Sniffer] 查询关注列表失败: ${result.status}`);
      setFollowReqStatus({ status: result.status, message: '请求失败' });
      return;
    }
    const data = result.data || {};
    const list = data?.data?.list || [];

    const onlineAuthors = [];
    for (const item of list) {
      const author = item?.author;
      if (!author) continue;
      if (authors.has(author.name)) {
        const targetEnvs = enabledEnvs.filter((env) =>
          getEnvAuthors(env).includes(author.name)
        );
        if (!targetEnvs.length) continue;
        console.log(
          `🎯 检测到关注的主播开播: ${author.name}，匹配环境: ${targetEnvs
            .map((env) => env.name)
            .join(', ')}`
        );
        onlineAuthors.push(author.name);
        handleStreamerOnline(
          author,
          item.id,
          item.playUrls || [],
          item.caption,
          targetEnvs
        );
      }
    }
    setFollowReqStatus({
      status: 200,
      message: '✅ 查询关注列表成功',
      onlineAuthors: onlineAuthors.join(','),
    });
  } catch (err) {
    console.warn('[Live Stream Sniffer] 查询关注列表异常:', err);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('pollFollowingLivings', {
    periodInMinutes: POLL_INTERVAL_MINUTES,
  });
  checkFollowingLivings();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'pollFollowingLivings') checkFollowingLivings();
});

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
