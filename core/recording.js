// core/recording.js
// 录制请求推送、状态查询、录制拒绝处理
// 监听 event-bus 的 STREAM_DETECTED 事件来触发录制

import { getState, persistActiveRecording, clearActiveRecording } from './state.js';
import { on, EVENTS } from './event-bus.js';
import { getConfig } from './config.js';
import { fetchJson } from '../lib/http.js';
import { getXiaohongshuLiveRoomId } from '../lib/url.js';
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

// 本场 live_room_id → host_user_id 的本地缓存（被动嗅探写入，手动录制读取）。
// 小红书直播间 URL 本身在多数情况下不含 host_id，手动发送时靠它补上稳定目标身份。
const XHS_HOST_CACHE_KEY = 'xhsLiveRoomHosts';
const XHS_HOST_CACHE_LIMIT = 100;

// SW 被回收后从 storage 懒加载；每个 JS realm（background / popup）各自持有一份。
let xhsHostCache = null;

async function getXhsHostMap() {
  if (xhsHostCache) return xhsHostCache;
  try {
    const data = await chrome.storage.local.get(XHS_HOST_CACHE_KEY);
    xhsHostCache = { ...(data?.[XHS_HOST_CACHE_KEY] || {}) };
  } catch (_) {
    xhsHostCache = {};
  }
  return xhsHostCache;
}

export async function cacheXhsLiveRoomHost(liveRoomId, hostUserId) {
  if (!liveRoomId || !hostUserId) return;
  const map = await getXhsHostMap();
  if (map[liveRoomId] === hostUserId) return;
  map[liveRoomId] = hostUserId;
  const keys = Object.keys(map);
  if (keys.length > XHS_HOST_CACHE_LIMIT) {
    for (const key of keys.slice(0, keys.length - XHS_HOST_CACHE_LIMIT)) {
      delete map[key];
    }
  }
  try {
    await chrome.storage.local.set({ [XHS_HOST_CACHE_KEY]: map });
  } catch (_) {}
}

async function getCachedXhsHost(liveRoomId) {
  if (!liveRoomId) return '';
  const map = await getXhsHostMap();
  return map[liveRoomId] || '';
}

// ===== 对外暴露 =====

/**
 * 查询指定环境直播间的录制状态与扩展弹幕开关
 * @returns {Promise<{isRecording: boolean, extensionDanmakuEnabled: boolean}>}
 */
export async function getEnvironmentRoomStatus(env, roomUrl) {
  if (!roomUrl) {
    return { isRecording: false, extensionDanmakuEnabled: false };
  }
  const result = await fetchJson(
    `${env.statusApiUrl}?url=${encodeURIComponent(roomUrl)}`
  );
  const data = result.data || {};
  const isRecording = Boolean(
    result.ok &&
      data.exists &&
      (data.data?.status === 'recording' || data.data?.status === 'paused')
  );
  const extensionDanmakuEnabled =
    data.data?.extension_danmaku_enabled === true ||
    data.data?.room?.extension_danmaku_enabled === true;
  return { isRecording, extensionDanmakuEnabled };
}

/**
 * 查询指定环境是否正在录制
 * 从 popup.js 和 background.js 移入（依赖 env.statusApiUrl，属于业务逻辑）
 */
export async function isEnvironmentRecording(env, roomUrl) {
  const { isRecording } = await getEnvironmentRoomStatus(env, roomUrl);
  return isRecording;
}

/**
 * 发送录制请求到指定环境（供 popup.js 手动录制使用）
 */
export async function sendRecordingRequest(env, streamUrl, title, roomUrl) {
  const liveRoomId = getXiaohongshuLiveRoomId(roomUrl);
  const hostUserId = await getCachedXhsHost(liveRoomId);
  const body = {
    url: streamUrl,
    title,
    room_url: roomUrl,
  };
  // 小红书：带上本场场次与（缓存到的）主播身份，让后端归并到稳定目标，
  // 而不是按直播间 URL 新建一条房间记录。
  if (liveRoomId) body.live_room_id = liveRoomId;
  if (hostUserId) body.host_user_id = hostUserId;
  return fetchJson(env.notifyApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
  caption = '',
  coverUrl = '',
  extra = {}
) {
  let activeCount = 0;
  const liveRoomId = extra.liveRoomId || getXiaohongshuLiveRoomId(roomUrl);
  const hostUserId = extra.hostUserId || (await getCachedXhsHost(liveRoomId));

  for (const env of environments) {
    if (!env.enabled) continue;

    // 先查后端状态，已在录制则跳过
    let alreadyRecording = false;
    try {
      const roomStatus = await getEnvironmentRoomStatus(env, roomUrl);
      if (roomStatus.isRecording) {
        console.log(`[Recording][${env.name}] 已在录制中，跳过: ${roomUrl}`);
        persistActiveRecording(roomUrl);
        activateDanmakuForRoom(roomUrl);
        if (roomStatus.extensionDanmakuEnabled) {
          setDanmakuEnabled(true);
          ensureDanmakuTab(roomUrl);
        }
        activeCount++;
        alreadyRecording = true;
      }
    } catch (err) {
      console.warn(`[Recording][${env.name}] 状态查询失败:`, err);
    }

    if (alreadyRecording) continue;

    // 未在录制，发送录制请求
    try {
      const body = {
        url,
        title: `${title}`,
        room_url: roomUrl,
        caption,
      };
      if (coverUrl) body.cover_url = coverUrl;
      // 小红书目标身份与本场场次标识（后端 RoomTargetService 用于归并稳定目标）
      if (hostUserId) body.host_user_id = hostUserId;
      if (liveRoomId) body.live_room_id = liveRoomId;
      const result = await fetchJson(env.notifyApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (result.ok) {
        persistActiveRecording(roomUrl);
        activateDanmakuForRoom(roomUrl);
        if (result.data?.data?.extension_danmaku_enabled === true) {
          setDanmakuEnabled(true);
          ensureDanmakuTab(roomUrl);
        }
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
  return activeCount;
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
