// core/recording.js
// 录制请求推送、状态查询、录制拒绝处理
// 监听 event-bus 的 STREAM_DETECTED 事件来触发录制

import { getState, persistActiveRecording, clearActiveRecording } from './state.js';
import { on, EVENTS } from './event-bus.js';
import { getConfig } from './config.js';
import { fetchJson } from '../lib/http.js';
import {
  activateDanmakuForRoom,
  deactivateDanmakuForRoom,
  ensureDanmakuTab,
  closeAutoOpenedTab,
} from './danmaku-session.js';
import { setDanmakuEnabled } from './danmaku-switch.js';

// ===== 内部辅助 =====

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

// ===== 对外暴露 =====

/**
 * 查询指定环境是否正在录制
 * 从 popup.js 和 background.js 移入（依赖 env.statusApiUrl，属于业务逻辑）
 */
export async function isEnvironmentRecording(env, roomUrl) {
  if (!roomUrl) return false;
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

/**
 * 发送录制请求到指定环境（供 popup.js 手动录制使用）
 */
export async function sendRecordingRequest(env, streamUrl, title, roomUrl) {
  return fetchJson(env.notifyApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: streamUrl,
      title,
      room_url: roomUrl,
    }),
  });
}

/**
 * 发送录制请求到指定环境列表
 * 录制成功后激活弹幕、启用开关、确保标签页
 * 录制被拒绝时清理状态并通知 Popup
 */
export async function sendToEnvironments(
  environments,
  url,
  title,
  roomUrl,
  caption = ''
) {
  let activeCount = 0;

  for (const env of environments) {
    if (!env.enabled) continue;

    // 先查后端状态，已在录制则跳过
    let alreadyRecording = false;
    try {
      if (await isEnvironmentRecording(env, roomUrl)) {
        console.log(`[Recording][${env.name}] 已在录制中，跳过: ${roomUrl}`);
        persistActiveRecording(roomUrl);
        activateDanmakuForRoom(roomUrl);
        setDanmakuEnabled(true);
        ensureDanmakuTab(roomUrl);
        activeCount++;
        alreadyRecording = true;
      }
    } catch (err) {
      console.warn(`[Recording][${env.name}] 状态查询失败:`, err);
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
        persistActiveRecording(roomUrl);
        activateDanmakuForRoom(roomUrl);
        setDanmakuEnabled(true);
        ensureDanmakuTab(roomUrl);
        activeCount++;
        console.log(`[Recording][${env.name}] 录制请求成功: ${roomUrl}`);
      } else if (result.data) {
        // 后端拒绝录制（如 400 暂停监听）
        const rejectionMsg =
          result.data?.message ||
          result.data?.status ||
          `HTTP ${result.status}`;
        console.warn(`[Recording][${env.name}] 录制被拒绝: ${rejectionMsg}`);
        closeAutoOpenedTab(roomUrl);
        deactivateDanmakuForRoom(roomUrl);
        // 通知 Popup 清除过期的录制中标记
        chrome.runtime
          .sendMessage({
            action: 'recording_rejected',
            roomUrl,
            streamUrl: url,
            message: rejectionMsg,
          })
          .catch(() => {});
      }
      console.log(`[DEBUG][${env.name}] response:`, JSON.stringify(result.data));
    } catch (err) {
      console.warn(`[Recording][${env.name}] 发送录制请求失败:`, err);
    }
  }

  if (activeCount > 0) {
    chrome.action.setBadgeText({ text: 'HIGH' });
    chrome.storage.local.set({ [`status_${url}`]: 'auto-recorded' });
  }
}

export async function sendToBackend(url, title, roomUrl, caption = '') {
  const config = await getConfig();
  await sendToEnvironments(
    getEnabledEnvironments(config),
    url,
    title,
    roomUrl,
    caption
  );
}

// ===== 事件总线订阅 =====

on(EVENTS.STREAM_DETECTED, async (payload) => {
  await sendToEnvironments(
    payload.environments,
    payload.url,
    payload.title,
    payload.roomUrl
  );
});
