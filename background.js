import {
  QUALITY_WEIGHTS,
  LIVING_API_URL,
  POLL_INTERVAL_MINUTES,
} from './config.js';
import { getConfig } from './utils.js';

let lastUrl = ''; // 简单防抖：防止同一地址短时间内多次弹出
let detectedStreams = [];
let autoRecordTimer = null;
let bestUrl = '';
let currentBestLevel = -1;

console.log('[Live Stream Sniffer]KS直播监测插件已启动');

async function sendToBackend(url, title, roomUrl, caption = '') {
  const config = await getConfig();
  fetch(config.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      title: `AUTO_${title}`,
      room_url: roomUrl,
      caption,
    }),
  }).then(() => {
    chrome.action.setBadgeText({ text: 'HIGH' });
    chrome.storage.local.set({ [`status_${url}`]: 'auto-recorded' });
  });
}

/**
 * 自动选择最佳清晰度的视频下载地址并发送给后端
 * @param {*} details
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

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    markKuaishouVisited(details.url);

    // 2. 只要包含 .flv 且 URL 还没被处理过就拦截
    if (details.url.includes('.flv') && details.url !== lastUrl) {
      // 排除掉一些可能的干扰项（可选）
      if (details.url.includes('log') || details.url.includes('stat')) {
        // 有些监控请求可能带 flv 字样但不是视频流
        // console.log('排除干扰项:', details.url);
        // return;
      }

      lastUrl = details.url;
      console.log('✅ 捕获到直播流地址:', details.url);
      detectedStreams.push(details.url);

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
});

// ===== 轮询关注列表，检测开播 =====

const notifiedRooms = new Set();

// 在 SW 重启时，从本地存储恢复已通知记录
chrome.storage.local.get('notifiedRooms', (result) => {
  if (result.notifiedRooms) {
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

async function checkFollowingLivings() {
  try {
    const { monitorEnabled } = await chrome.storage.sync.get('monitorEnabled');
    if (monitorEnabled === false) return;

    const { kuaishouVisited } =
      await chrome.storage.local.get('kuaishouVisited');
    if (!kuaishouVisited) return;

    const config = await getConfig();
    const authors = config.followedAuthors;
    if (!authors.length) return;

    // 随机延迟 2~6s，避免每次请求时间固定被风控
    await randomDelay(2000, 6000);

    const resp = await fetch(LIVING_API_URL, { credentials: 'include' });
    if (!resp.ok) {
      console.warn(`[Live Stream Sniffer] 查询关注列表失败: ${resp.status}`);
      return;
    }
    const data = await resp.json();
    const list = data?.data?.list || [];
    for (const item of list) {
      const author = item?.author;
      if (!author) continue;
      if (authors.includes(author.name)) {
        console.log(`🎯 检测到关注的主播开播: ${author.name}`);
        handleStreamerOnline(
          author,
          item.id,
          item.playUrls || [],
          item.caption
        );
      }
    }
  } catch (err) {
    console.error('[Live Stream Sniffer] 查询关注列表异常:', err);
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
