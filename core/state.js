// core/state.js
// 统一状态仓库 — 集中管理所有运行时状态
//
// 核心数据结构（JSDoc）:
//
// /**
//  * @typedef {Object} StreamObject
//  * @property {string} url          - 直播流 CDN 地址
//  * @property {string} roomUrl      - 直播间页面 URL
//  * @property {string} title        - 直播间标题
//  * @property {string} quality      - 清晰度标识
//  * @property {number} detectedAt   - 检测时间戳
//  */
//
// /**
//  * @typedef {Object} DanmakuSession
//  * @property {string} roomUrl
//  * @property {number} sessionStartMs
//  * @property {number} tabId
//  * @property {string} streamUrl
//  * @property {string} title
//  * @property {boolean} active
//  * @property {number} totalCount
//  */
//
// /**
//  * @typedef {Object} EnvironmentConfig
//  * @property {string} apiUrl
//  * @property {string} statusApiUrl
//  * @property {string} name
//  * @property {boolean} danmakuEnabled
//  */

import { STORAGE_KEYS } from '../lib/constants.js';

// ===== 内存状态（Service Worker 重启后丢失，需从 storage 恢复） =====

const state = {
  // 直播流检测
  lastUrl: '',
  detectedStreams: [],

  // 清晰度选择（临时状态，仅内存）
  bestStreamsByRoom: new Map(),

  // 录制状态
  activeRecordingRoomUrl: null,

  // 弹幕会话
  danmakuSessions: new Map(),      // roomUrl -> session 对象
  danmakuBatchBuffer: new Map(),   // roomUrl -> events[]
  autoOpenedTabs: new Map(),       // roomUrl -> tabId

  // 关注轮询
  notifiedRooms: new Set(),
};

export function getState() { return state; }

export function updateState(partial) {
  Object.assign(state, partial);
}

// ===== 持久化写入（原子操作，防并发写入覆盖） =====
//
// Chrome 扩展的 onMessage、webRequest、alarms 是完全并发异步触发的。
// 如果两个事件同时读取→修改→写入 storage，会导致 Race Condition。
// 因此所有涉及"读取-变更-写入"的持久化操作必须通过以下原子接口执行。

let _storageLock = Promise.resolve();

function withStorageLock(fn) {
  const next = _storageLock.then(fn, fn);
  _storageLock = next.catch(() => {});
  return next;
}

export function persistStreams(streams) {
  return withStorageLock(async () => {
    state.detectedStreams = streams;
    await chrome.storage.local.set({ [STORAGE_KEYS.STREAMS]: streams });
  });
}

/** 原子追加一条直播流记录，防止并发写入覆盖 */
export async function atomicAppendStream(stream) {
  return withStorageLock(async () => {
    const result = await chrome.storage.local.get(STORAGE_KEYS.STREAMS);
    const existing = Array.isArray(result[STORAGE_KEYS.STREAMS]) ? result[STORAGE_KEYS.STREAMS] : [];
    const updated = [...existing, stream].slice(-100);
    state.detectedStreams = updated;
    await chrome.storage.local.set({ [STORAGE_KEYS.STREAMS]: updated });
  });
}

export function persistNotifiedRooms(rooms) {
  return withStorageLock(async () => {
    state.notifiedRooms = rooms;
    await chrome.storage.local.set({ [STORAGE_KEYS.NOTIFIED_ROOMS]: [...rooms] });
  });
}

export function persistActiveRecording(roomUrl) {
  return withStorageLock(async () => {
    state.activeRecordingRoomUrl = roomUrl;
    await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_RECORDING_ROOM]: roomUrl });
  });
}

export function clearActiveRecording() {
  return withStorageLock(async () => {
    state.activeRecordingRoomUrl = null;
    await chrome.storage.local.remove(STORAGE_KEYS.ACTIVE_RECORDING_ROOM);
  });
}

// ===== Service Worker 启动时恢复 =====

export async function restoreState() {
  const result = await chrome.storage.local.get([
    STORAGE_KEYS.NOTIFIED_ROOMS,
    STORAGE_KEYS.STREAMS,
    STORAGE_KEYS.ACTIVE_RECORDING_ROOM,
    'activeRecordingByEnv', // 旧版兼容迁移
  ]);

  if (result[STORAGE_KEYS.NOTIFIED_ROOMS]) {
    for (const id of result[STORAGE_KEYS.NOTIFIED_ROOMS]) {
      state.notifiedRooms.add(id);
    }
  }

  if (Array.isArray(result[STORAGE_KEYS.STREAMS])) {
    state.detectedStreams = result[STORAGE_KEYS.STREAMS].slice(-100);
    if (state.detectedStreams.length) {
      chrome.action.setBadgeText({ text: state.detectedStreams.length.toString() });
      chrome.action.setBadgeBackgroundColor({ color: '#ff5000' });
    }
  }

  if (result[STORAGE_KEYS.ACTIVE_RECORDING_ROOM]) {
    state.activeRecordingRoomUrl = result[STORAGE_KEYS.ACTIVE_RECORDING_ROOM];
  } else if (result?.activeRecordingByEnv) {
    // 旧版迁移：从 activeRecordingByEnv 提取 activeRecordingRoomUrl
    const active = Object.values(result.activeRecordingByEnv).find(
      (item) => item?.roomUrl
    );
    state.activeRecordingRoomUrl = active?.roomUrl || null;
    if (state.activeRecordingRoomUrl) {
      await chrome.storage.local.set({
        [STORAGE_KEYS.ACTIVE_RECORDING_ROOM]: state.activeRecordingRoomUrl,
      });
    }
    await chrome.storage.local.remove('activeRecordingByEnv');
  }
}
