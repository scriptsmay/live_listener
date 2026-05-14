import { QUALITY_WEIGHTS } from './config.js';
import { getConfig } from './utils.js';

let lastUrl = ''; // 简单防抖：防止同一地址短时间内多次弹出
let detectedStreams = [];
let autoRecordTimer = null;
let bestUrl = '';
let currentBestLevel = -1;

console.log('[Live Stream Sniffer]KS直播监测插件已启动');

async function sendToBackend(url, title, roomUrl) {
  const config = await getConfig();
  fetch(config.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, title: `AUTO_${title}`, room_url: roomUrl }),
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
    if (chrome.runtime.lastError || !tab || !tab.title.includes('KSG无言')) return;
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

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    // 1. 打印所有请求（调试用，确认后可删除）
    // console.log('请求详情:', details.url);

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
        if (chrome.runtime.lastError || !tab) return;

        // 3. 关键判断：标题是否包含“KSG无言”
        if (tab.title && tab.title.includes('KSG无言')) {
          console.log(`🎯 匹配到目标直播间: ${tab.title}，准备自动录制...`);
          autoChooseBest(details);
        }
      });
    }
  },
  // 3. 这里的 urls 过滤也要同步扩大
  { urls: ['<all_urls>'] },
);

// 监听来自 Popup 的清空指令
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
});
