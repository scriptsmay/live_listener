import {
  QUALITY_WEIGHTS,
  LIVING_API_URL,
  POLL_INTERVAL_MINUTES,
  getConfig,
} from './config.js';

let lastUrl = ''; // 简单防抖：防止同一地址短时间内多次弹出

// 检测到的直播流，应该是一个对象，包含 url、title、roomUrl 等信息，方便后续扩展
let detectedStreams = [];
let autoRecordTimer = null;
let bestUrl = '';
let currentBestLevel = -1;
let activeRecordingRoomUrl = null; // 当前正在录制中的直播间URL，不为空时跳过关注列表请求

console.log('[Live Stream Sniffer]KS直播监测插件已启动');

async function sendToBackend(url, title, roomUrl, caption = '') {
  const config = await getConfig();

  for (const env of config.environments) {
    if (!env.enabled) continue;

    // 先查后端状态，已在录制则跳过
    let alreadyRecording = false;
    try {
      const resp = await fetch(
        `${env.statusApiUrl}?url=${encodeURIComponent(roomUrl)}`
      );
      const data = await resp.json();
      if (
        data.exists &&
        (data.data?.status === 'recording' || data.data?.status === 'paused')
      ) {
        console.log(
          `[Live Stream Sniffer][${env.name}] 已在录制中，跳过: ${roomUrl}`
        );
        alreadyRecording = true;
      }
    } catch (err) {
      console.warn(`[Live Stream Sniffer][${env.name}] 状态查询失败:`, err);
    }

    if (alreadyRecording) continue;

    // 未在录制，发送录制请求
    try {
      const res = await fetch(env.notifyApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          title: `AUTO_${title}`,
          room_url: roomUrl,
          caption,
        }),
      });
      if (res.ok) {
        console.log(
          `[Live Stream Sniffer][${env.name}] 录制请求成功: ${roomUrl}`
        );
      }
      const data = await res.json();
      console.log(`[DEBUG][${env.name}] response:`, JSON.stringify(data));
    } catch (err) {
      console.warn(`[Live Stream Sniffer][${env.name}] 发送录制请求失败:`, err);
    }
  }

  // 任一环境成功即可标记
  chrome.action.setBadgeText({ text: 'HIGH' });
  chrome.storage.local.set({ [`status_${url}`]: 'auto-recorded' });
  activeRecordingRoomUrl = roomUrl;
}

/**
 * 自动选择最佳清晰度的视频下载地址并发送给后端
 */
function autoChooseBest(details) {
  const tabId = details.tabId;

  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    const roomUrl = tab.url;

    // --- 核心：清晰度判定 ---
    let weight = 0;
    for (let key in QUALITY_WEIGHTS) {
      if (details.url.includes(key)) {
        weight = QUALITY_WEIGHTS[key];
        break;
      }
    }

    // 如果这个流比刚才抓到的更清晰，则更新
    if (weight > currentBestLevel) {
      currentBestLevel = weight;
      bestUrl = details.url;
      console.log(`🚀 发现更优画质 (${weight}):`, details.url);
    }

    // --- 延迟 2 秒发送，等待所有潜在的清晰度流都冒出来 ---
    if (autoRecordTimer) clearTimeout(autoRecordTimer);
    autoRecordTimer = setTimeout(() => {
      sendToBackend(bestUrl, tab.title, roomUrl);
      // 重置状态，准备下一次可能的切换（比如主播断流重开）
      currentBestLevel = -1;
      bestUrl = '';
    }, 2000);
  });
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
          `获取标签页 ${details.tabId} 失败: ${chrome.runtime.lastError.message}`
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
      lastUrl = details.url;

      const roomUrl = tab.url || '';
      const title = tab.title;

      const detectedInfo = {
        url: details.url,
        title,
        roomUrl,
      };
      detectedStreams.push(detectedInfo);
      console.log(
        '✅ 捕获到直播流地址:',
        details.url,
        '| 直播间 URL:',
        roomUrl,
        '标题:',
        title
      );
      // detectedStreams.push(details.url);

      // 更新图标上的数字
      chrome.action.setBadgeText({ text: detectedStreams.length.toString() });
      chrome.action.setBadgeBackgroundColor({ color: '#ff5000' }); // 快手橙

      // 存入本地存储，方便 Popup 读取
      chrome.storage.local.set({ streams: detectedStreams });

      // 2. 获取该标签页的信息
      const tabId = details.tabId;
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab || !tab.title) return;

        // 3. 匹配关注列表中的主播
        getConfig().then((config) => {
          const matched = config.followedAuthors.find((a) =>
            tab.title.includes(a)
          );
          if (matched) {
            console.log(`🎯 匹配到目标直播间: ${tab.title}，准备自动录制...`);
            autoChooseBest(details);
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

    // 与 webRequest 捕获去重
    if (url === lastUrl) return;
    lastUrl = url;

    console.log('✅ [content] 捕获到直播流地址:', url);
    detectedStreams.push(url);
    chrome.action.setBadgeText({ text: detectedStreams.length.toString() });
    chrome.action.setBadgeBackgroundColor({ color: '#ff5000' });
    chrome.storage.local.set({ streams: detectedStreams });

    // 匹配关注列表中的主播
    getConfig().then((config) => {
      const matched = config.followedAuthors.find((a) => tab.title.includes(a));
      if (matched) {
        console.log(`🎯 [content] 匹配到目标直播间: ${tab.title}`);
        // video.currentSrc 已是页面选好的清晰度，无需 quality 等待
        sendToBackend(url, tab.title, tab.url);
      }
    });
    return true;
  }
});

// ===== 轮询关注列表，检测开播 =====

const notifiedRooms = new Set();

// 在 SW 重启时，从本地存储恢复已通知记录
chrome.storage.local.get('notifiedRooms', (result) => {
  if (result && result.notifiedRooms) {
    for (const id of result.notifiedRooms) notifiedRooms.add(id);
  }
});

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

async function handleStreamerOnline(author, roomId, playUrls, caption) {
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
    console.log(`🎥 ${author.name} 自动发送直播流到后端`);
    sendToBackend(flvUrl, author.name, roomUrl, caption);
  } else {
    // API 未返回流地址，尝试打开直播间让 webRequest 捕获
    console.log(
      `🌐 ${author.name} 无流地址，尝试打开直播间页面让 webRequest 捕获`
    );
    chrome.tabs.query(
      { url: `*://live.kuaishou.com/u/${author.id}*` },
      (tabs) => {
        if (!tabs || !tabs.length) {
          chrome.tabs.create({ url: roomUrl, active: false });
        }
      }
    );
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
 * - 如果已有正在录制的直播间，先检查后端录制状态，避免频繁请求快手接口
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
 * 2. 如果有正在录制的直播间，检查后端录制状态
 *    - 如果仍在录制中（recording或paused状态），跳过本次查询
 *    - 如果不在录制中，清除录制标记，继续正常查询
 * 3. 检查是否访问过快手页面，未访问则返回
 * 4. 获取配置的关注主播列表，为空则返回
 * 5. 添加2-6秒随机延迟，避免被风控
 * 6. 请求快手关注列表API，获取正在直播的主播
 * 7. 遍历直播列表，匹配关注的主播，触发录制处理
 */
async function checkFollowingLivings() {
  try {
    const { monitorEnabled } = await chrome.storage.sync.get('monitorEnabled');
    if (monitorEnabled === false) return;

    // 如果已有正在录制的直播间，先查后端状态，无需每次都请求快手接口
    if (activeRecordingRoomUrl) {
      const config = await getConfig();
      let anyRecording = false;
      for (const env of config.environments) {
        if (!env.enabled) continue;
        try {
          const resp = await fetch(
            `${env.statusApiUrl}?url=${encodeURIComponent(activeRecordingRoomUrl)}`
          );
          const data = await resp.json();
          if (
            data.exists &&
            (data.data?.status === 'recording' ||
              data.data?.status === 'paused')
          ) {
            anyRecording = true;
            break;
          }
        } catch (_) {}
      }
      if (anyRecording) {
        console.log('[Live Stream Sniffer] 仍在录制中，跳过关注列表查询');
        return;
      }
      // 不在录制中了，清除标记，下次正常查询关注列表
      activeRecordingRoomUrl = null;
    }

    const { kuaishouVisited } =
      await chrome.storage.local.get('kuaishouVisited');
    if (!kuaishouVisited) return;

    const config = await getConfig();
    const authors = config.followedAuthors;
    if (!authors.length) return;

    // 随机延迟 2~6s，避免每次请求时间固定被风控
    await randomDelay(2000, 6000);

    console.log('[Live Stream Sniffer] 查询关注列表，检测开播中...');
    const resp = await fetch(LIVING_API_URL, { credentials: 'include' });

    if (!resp.ok) {
      console.warn(`[Live Stream Sniffer] 查询关注列表失败: ${resp.status}`);
      setFollowReqStatus({ status: resp.status, message: '请求失败' });
      return;
    }
    const data = await resp.json();
    const list = data?.data?.list || [];

    const onlineAuthors = [];
    for (const item of list) {
      const author = item?.author;
      if (!author) continue;
      if (authors.includes(author.name)) {
        console.log(`🎯 检测到关注的主播开播: ${author.name}`);
        onlineAuthors.push(author.name);
        handleStreamerOnline(
          author,
          item.id,
          item.playUrls || [],
          item.caption
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
