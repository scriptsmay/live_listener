// core/stream-detector.js
// 直播流检测、去重
// 对外暴露 handleWebRequest(details) 和 handleContentStream(stream) 两个入口函数
// 通过 event-bus 发射 STREAM_DETECTED 事件，不再直接调用 recording 模块

import { getState, atomicAppendStream } from './state.js';
import { emit, EVENTS } from './event-bus.js';
import { getConfig } from './config.js';
import { getQualityWeight } from './stream-quality.js';
import { isKuaishouLiveRoomUrl, getLiveRoomUrlFromRequest } from '../lib/url.js';

/**
 * webRequest onBeforeRequest 入口
 * 拦截 .flv 流请求，检测直播间流地址
 */
export async function handleWebRequest(details) {
  const state = getState();

  // 标记是否访问过快手页面（前置条件：有 cookie 才能调 API）
  if (
    details.url.includes('.kuaishou.com') &&
    !details.url.includes('log') &&
    !details.url.includes('stat')
  ) {
    chrome.storage.local.set({ kuaishouVisited: true });
  }

  // 只要包含 .flv 且 URL 还没被处理过就拦截
  if (!details.url.includes('.flv') || details.url === state.lastUrl) return;

  if (details.tabId === -1) return;

  const tab = await new Promise((resolve) => {
    chrome.tabs.get(details.tabId, (t) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(t);
    });
  });
  if (!tab) return;

  const roomUrl = getLiveRoomUrlFromRequest(details, tab) || '';
  if (!isKuaishouLiveRoomUrl(roomUrl)) return;

  state.lastUrl = details.url;

  const title = tab.title;
  const detectedInfo = {
    url: details.url,
    title,
    roomUrl,
    capturedAt: Date.now(),
  };
  atomicAppendStream(detectedInfo);

  console.log('[StreamDetector] 捕获到直播流地址:', details.url, '| 直播间:', roomUrl);

  // 按环境匹配关注列表中的主播
  const config = await getConfig();
  const enabledEnvs = config.environments.filter((env) => env.enabled);
  const targetEnvs = enabledEnvs.filter((env) =>
    (Array.isArray(env.followedAuthors) ? env.followedAuthors : []).some(
      (author) => tab.title?.includes(author)
    )
  );

  if (targetEnvs.length) {
    console.log(
      `[StreamDetector] 匹配到目标直播间: ${tab.title}，准备自动录制到 ${targetEnvs
        .map((env) => env.name)
        .join(', ')}`
    );
    autoChooseBest(details, targetEnvs, roomUrl, title);
  }
}

/**
 * content.js 视频流检测入口
 * 处理 content script 通过 addMedia 消息发送的流地址
 */
export function handleContentStream(stream) {
  const state = getState();

  // 与 webRequest 捕获去重
  if (stream.url === state.lastUrl) return;
  state.lastUrl = stream.url;

  console.log('[StreamDetector] [content] 捕获到直播流地址:', stream.url);

  const detectedInfo = {
    url: stream.url,
    title: stream.title,
    roomUrl: stream.roomUrl,
    capturedAt: Date.now(),
  };
  atomicAppendStream(detectedInfo);

  // 异步匹配目标环境
  getConfig().then((config) => {
    const enabledEnvs = config.environments.filter((env) => env.enabled);
    const targetEnvs = enabledEnvs.filter((env) =>
      (Array.isArray(env.followedAuthors) ? env.followedAuthors : []).some(
        (author) => stream.title?.includes(author)
      )
    );

    if (targetEnvs.length) {
      console.log(
        `[StreamDetector] [content] 匹配到目标直播间: ${stream.title}，发送到 ${targetEnvs
          .map((env) => env.name)
          .join(', ')}`
      );
      // video.currentSrc 已是页面选好的清晰度，直接发射事件
      emit(EVENTS.STREAM_DETECTED, {
        environments: targetEnvs,
        url: stream.url,
        title: stream.title,
        roomUrl: stream.roomUrl,
      });
    }
  });
}

/**
 * 自动选择最佳清晰度的视频下载地址
 * 延迟 2 秒等待所有清晰度流冒出来后，发射 STREAM_DETECTED 事件
 */
function autoChooseBest(details, targetEnvs, roomUrl, title) {
  if (!isKuaishouLiveRoomUrl(roomUrl)) return;

  const state = getState();
  const key = roomUrl;
  const weight = getQualityWeight(details.url);
  const best = state.bestStreamsByRoom.get(key) || {
    timer: null,
    bestUrl: '',
    currentBestLevel: -1,
    title,
    targetEnvs,
  };

  best.title = title;
  best.targetEnvs = targetEnvs;

  // 如果这个流比刚才抓到的更清晰，则更新
  if (weight > best.currentBestLevel) {
    best.currentBestLevel = weight;
    best.bestUrl = details.url;
    console.log(`[StreamDetector] 发现更优画质 (${weight}):`, details.url);
  }

  // 延迟 2 秒发送，等待所有潜在的清晰度流都冒出来
  if (best.timer) clearTimeout(best.timer);
  best.timer = setTimeout(() => {
    if (best.bestUrl) {
      emit(EVENTS.STREAM_DETECTED, {
        environments: best.targetEnvs,
        url: best.bestUrl,
        title: best.title,
        roomUrl,
      });
    }
    state.bestStreamsByRoom.delete(key);
  }, 2000);

  state.bestStreamsByRoom.set(key, best);
}
