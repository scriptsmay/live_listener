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

import { STORAGE_KEYS, DANMAKU_HEALTH } from '../lib/constants.js';
import { normalizeRoomUrl } from '../lib/url.js';

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
  danmakuSessions: new Map(), // roomUrl -> session 对象
  danmakuBatchBuffer: new Map(), // roomUrl -> events[]
  autoOpenedTabs: new Map(), // roomUrl -> tabId（持久化，SW 重启后恢复）

  // 自动标签页健康恢复（D3）
  danmakuLastRecoveryAt: new Map(), // roomUrl -> 最近一次重载/新建时间戳（持久化）
  // roomUrl -> { count, firstFailureAt }（持久化）
  // MV3 SW 空闲销毁后计数不能丢，否则每次唤醒都从 1 重新累计，永远达不到阈值。
  danmakuProbeFailures: new Map(),
  // roomUrl -> { at, tabId }（持久化）：标记"本次页面卸载是扩展主动重载"，
  // 用于忽略由此产生的 danmaku_stop，避免重载把弹幕采集永久关掉。
  danmakuReloadExpected: new Map(),
  danmakuLastProbeAt: new Map(), // roomUrl -> 最近一次探测时间（探测节流，仅内存）
  danmakuRecoveryPromises: new Map(), // roomUrl -> 进行中的恢复 Promise（关闭时需等待）
  danmakuClosing: new Set(), // 正在关闭自动标签页的房间，禁止新恢复启动
  danmakuStartInFlight: new Set(), // 正在补发 start_danmaku 的房间，防止重试链重复
  danmakuResumeResent: new Set(), // `${roomUrl}|${recoveredAt}` 已补发 start_danmaku 的恢复批次
  danmakuCreateInFlight: new Map(), // roomUrl -> 进行中的建标签页 Promise（并发去重）

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

// ===== 自动标签页映射（MV3 必须持久化） =====
//
// autoOpenedTabs 记录扩展自己打开的标签页（roomUrl -> tabId）。
// Service Worker 随时可能被回收，只存内存会导致重启后把自动标签页当成
// 用户手动标签页，进而拒绝重载/关闭。因此每一次增删都立即落盘。

function serializeAutoOpenedTabs() {
  return Object.fromEntries(state.autoOpenedTabs);
}

function serializeRecoveryAttempts() {
  return Object.fromEntries(state.danmakuLastRecoveryAt);
}

function serializeProbeFailures() {
  return Object.fromEntries(state.danmakuProbeFailures);
}

function serializeReloadExpected() {
  return Object.fromEntries(state.danmakuReloadExpected);
}

/** 原子记录一个自动打开标签页（内存 + storage 同步更新） */
export function atomicSetAutoOpenedTab(roomUrl, tabId) {
  return withStorageLock(async () => {
    state.autoOpenedTabs.set(roomUrl, tabId);
    await chrome.storage.local.set({
      [STORAGE_KEYS.AUTO_OPENED_TABS]: serializeAutoOpenedTabs(),
    });
  });
}

/** 原子删除一个自动打开标签页（内存 + storage 同步更新） */
export function atomicDeleteAutoOpenedTab(roomUrl) {
  return withStorageLock(async () => {
    state.autoOpenedTabs.delete(roomUrl);
    await chrome.storage.local.set({
      [STORAGE_KEYS.AUTO_OPENED_TABS]: serializeAutoOpenedTabs(),
    });
  });
}

// ===== 自动标签页恢复冷却（D3） =====
//
// 冷却时间戳同样持久化：若 SW 在重载触发的瞬间被回收，
// 内存中的冷却锁会丢失并可能在页面加载期再次重载，形成风暴。

/** 获取房间最近一次恢复（重载/新建）时间戳，无记录返回 0 */
export function getDanmakuLastRecoveryAt(roomUrl) {
  return state.danmakuLastRecoveryAt.get(roomUrl) || 0;
}

/**
 * 原子记录恢复尝试时间戳。调用方必须在 chrome.tabs.reload() 之前 await 本函数，
 * 保证冷却锁先落盘再触发重载。
 */
export function atomicMarkDanmakuRecoveryAttempt(roomUrl, at = Date.now()) {
  return withStorageLock(async () => {
    state.danmakuLastRecoveryAt.set(roomUrl, at);
    // 清理该房间旧恢复批次的补发去重标记，避免 Set 无限增长
    const prefix = `${roomUrl}|`;
    for (const key of state.danmakuResumeResent) {
      if (key.startsWith(prefix)) state.danmakuResumeResent.delete(key);
    }
    await chrome.storage.local.set({
      [STORAGE_KEYS.DANMAKU_LAST_RECOVERY]: serializeRecoveryAttempts(),
    });
  });
}

/**
 * 原子清除房间的恢复状态：冷却时间戳、失败计数、重载标记与补发去重标记。
 * 关闭自动标签页 / 恢复成功后调用，避免 storage 累积。
 */
export function atomicClearDanmakuRecovery(roomUrl) {
  return withStorageLock(async () => {
    state.danmakuLastRecoveryAt.delete(roomUrl);
    state.danmakuProbeFailures.delete(roomUrl);
    state.danmakuReloadExpected.delete(roomUrl);
    const prefix = `${roomUrl}|`;
    for (const key of state.danmakuResumeResent) {
      if (key.startsWith(prefix)) state.danmakuResumeResent.delete(key);
    }
    await chrome.storage.local.set({
      [STORAGE_KEYS.DANMAKU_LAST_RECOVERY]: serializeRecoveryAttempts(),
      [STORAGE_KEYS.DANMAKU_PROBE_FAILURES]: serializeProbeFailures(),
      [STORAGE_KEYS.DANMAKU_RELOAD_EXPECTED]: serializeReloadExpected(),
    });
  });
}

// ===== 连续探测失败计数（持久化，跨 SW 重启累计） =====

/**
 * 原子记录一次探测失败并返回累计次数。
 * 计数与首次失败时间同时落盘：即使 SW 在下一次探测前被销毁，
 * 下次唤醒（1 分钟 alarm）也能接着累计到阈值。
 */
export function atomicIncrementDanmakuProbeFailure(roomUrl, at = Date.now()) {
  return withStorageLock(async () => {
    const existing = state.danmakuProbeFailures.get(roomUrl);
    const count = (existing?.count || 0) + 1;
    state.danmakuProbeFailures.set(roomUrl, {
      count,
      firstFailureAt: existing?.firstFailureAt || at,
    });
    await chrome.storage.local.set({
      [STORAGE_KEYS.DANMAKU_PROBE_FAILURES]: serializeProbeFailures(),
    });
    return count;
  });
}

/** 原子重置房间的连续探测失败计数（健康探测或恢复完成后调用） */
export function atomicResetDanmakuProbeFailures(roomUrl) {
  return withStorageLock(async () => {
    state.danmakuProbeFailures.delete(roomUrl);
    await chrome.storage.local.set({
      [STORAGE_KEYS.DANMAKU_PROBE_FAILURES]: serializeProbeFailures(),
    });
  });
}

// ===== "本次卸载由扩展发起"标记（防止恢复重载关掉弹幕采集） =====

/**
 * 原子标记房间即将由扩展主动重载/导航。
 * 必须在 chrome.tabs.reload()/update() 之前 await：页面 unload 时 content.js
 * 会发 danmaku_stop，message-router 依据该标记跳过会话销毁，否则重载后
 * danmakuEnabled 已被置 false，采集再也不会启动。
 */
export function atomicMarkDanmakuReloadExpected(roomUrl, tabId, at = Date.now()) {
  return withStorageLock(async () => {
    state.danmakuReloadExpected.set(roomUrl, { at, tabId });
    await chrome.storage.local.set({
      [STORAGE_KEYS.DANMAKU_RELOAD_EXPECTED]: serializeReloadExpected(),
    });
  });
}

/** 判断房间当前是否处于"扩展主动重载"窗口内 */
export function isDanmakuReloadExpected(roomUrl, now = Date.now()) {
  const record = state.danmakuReloadExpected.get(roomUrl);
  if (!record || typeof record.at !== 'number') return false;
  return now - record.at < DANMAKU_HEALTH.RELOAD_EXPECTED_TTL_MS;
}

/**
 * 原子消费（清除）房间的重载标记。
 * 在重载后首次收到 danmaku_stop 时清除，确保之后用户手动离开该房间
 * 产生的 danmaku_stop 仍能正常清理会话。
 */
export function atomicClearDanmakuReloadExpected(roomUrl) {
  return withStorageLock(async () => {
    state.danmakuReloadExpected.delete(roomUrl);
    await chrome.storage.local.set({
      [STORAGE_KEYS.DANMAKU_RELOAD_EXPECTED]: serializeReloadExpected(),
    });
  });
}

// ===== Service Worker 启动时恢复 =====
//
// background.js 在 restoreState() 完成前就已注册 onMessage，消息处理可能抢跑。
// 若此时 autoOpenedTabs 还是空的，ensureDanmakuTab 会新建一个标签页，
// restore 随后又把 storage 中的旧标签页恢复进来 —— 两个标签页、一个成孤儿。
// 因此对外暴露 stateRestored，所有涉及自动标签页的函数先等它完成。
let _resolveStateRestored;
export const stateRestored = new Promise((resolve) => {
  _resolveStateRestored = resolve;
});

export async function restoreState() {
  try {
    await restoreStateInternal();
  } finally {
    _resolveStateRestored();
  }
}

async function restoreStateInternal() {
  const result = await chrome.storage.local.get([
    STORAGE_KEYS.NOTIFIED_ROOMS,
    STORAGE_KEYS.STREAMS,
    STORAGE_KEYS.ACTIVE_RECORDING_ROOM,
    STORAGE_KEYS.AUTO_OPENED_TABS,
    STORAGE_KEYS.DANMAKU_LAST_RECOVERY,
    STORAGE_KEYS.DANMAKU_PROBE_FAILURES,
    STORAGE_KEYS.DANMAKU_RELOAD_EXPECTED,
    'activeRecordingByEnv', // 旧版兼容迁移
  ]);

  // 恢复自动标签页映射（MV3 SW 重启后必须能识别哪些标签页是扩展打开的）
  //
  // 浏览器重启后 tabId 可能被复用，仅凭 ID 会把用户自己的标签页误判为
  // 自动标签页（从而被重载/关闭）。因此恢复时校验 URL 是否仍指向该房间，
  // 不匹配或标签页已不存在则丢弃该条映射。
  const storedAutoTabs = result[STORAGE_KEYS.AUTO_OPENED_TABS];
  if (storedAutoTabs && typeof storedAutoTabs === 'object') {
    const valid = [];
    const invalid = [];
    for (const [roomUrl, tabId] of Object.entries(storedAutoTabs)) {
      if (typeof tabId !== 'number') {
        invalid.push([roomUrl, tabId]);
        continue;
      }
      let matches = false;
      try {
        const tab = await chrome.tabs.get(tabId);
        if (typeof tab?.url === 'string' && tab.url === '') {
          // 标签页仍在加载（尚无 URL）：保留映射，避免 SW 恰好在此期间
          // 重启时把自动标签页误判为已丢失，进而重复新建产生孤儿标签页。
          matches = true;
        } else {
          matches = normalizeRoomUrl(tab?.url || '') === normalizeRoomUrl(roomUrl);
        }
      } catch (_) {
        matches = false; // 标签页已不存在
      }
      (matches ? valid : invalid).push([roomUrl, tabId]);
    }

    // 走 storage 锁并"合并"写入：保留恢复期间新增的映射，只剔除确认失效的条目
    await withStorageLock(async () => {
      for (const [roomUrl, tabId] of valid) {
        if (!state.autoOpenedTabs.has(roomUrl)) {
          state.autoOpenedTabs.set(roomUrl, tabId);
        }
      }
      let dirty = false;
      for (const [roomUrl, tabId] of invalid) {
        // 仅当内存中仍是这条失效映射时才删除，避免误删并发新增的映射
        if (state.autoOpenedTabs.get(roomUrl) === tabId) {
          state.autoOpenedTabs.delete(roomUrl);
          dirty = true;
        } else if (!state.autoOpenedTabs.has(roomUrl)) {
          dirty = true; // storage 中残留失效条目，需要重写
        }
      }
      if (dirty) {
        await chrome.storage.local.set({
          [STORAGE_KEYS.AUTO_OPENED_TABS]: serializeAutoOpenedTabs(),
        });
      }
    });
  }

  // 恢复恢复冷却时间戳，避免 SW 在重载时被回收后立刻再次重载
  const now = Date.now();
  const maxAge = DANMAKU_HEALTH.RECOVERY_RECORD_MAX_AGE_MS;

  const storedRecovery = result[STORAGE_KEYS.DANMAKU_LAST_RECOVERY];
  if (storedRecovery && typeof storedRecovery === 'object') {
    await withStorageLock(async () => {
      let dirty = false;
      for (const [roomUrl, at] of Object.entries(storedRecovery)) {
        if (typeof at === 'number' && now - at < maxAge) {
          if (!state.danmakuLastRecoveryAt.has(roomUrl)) {
            state.danmakuLastRecoveryAt.set(roomUrl, at);
          }
        } else {
          dirty = true;
        }
      }
      if (dirty) {
        await chrome.storage.local.set({
          [STORAGE_KEYS.DANMAKU_LAST_RECOVERY]: serializeRecoveryAttempts(),
        });
      }
    });
  }

  // 恢复连续失败计数：跨 SW 重启累计，否则每次唤醒都重新从 1 计数
  const storedFailures = result[STORAGE_KEYS.DANMAKU_PROBE_FAILURES];
  if (storedFailures && typeof storedFailures === 'object') {
    await withStorageLock(async () => {
      let dirty = false;
      for (const [roomUrl, record] of Object.entries(storedFailures)) {
        const count = record?.count;
        const firstFailureAt = record?.firstFailureAt;
        if (
          typeof count === 'number' &&
          count > 0 &&
          typeof firstFailureAt === 'number' &&
          now - firstFailureAt < maxAge
        ) {
          if (!state.danmakuProbeFailures.has(roomUrl)) {
            state.danmakuProbeFailures.set(roomUrl, { count, firstFailureAt });
          }
        } else {
          dirty = true;
        }
      }
      if (dirty) {
        await chrome.storage.local.set({
          [STORAGE_KEYS.DANMAKU_PROBE_FAILURES]: serializeProbeFailures(),
        });
      }
    });
  }

  // 恢复"扩展主动重载"标记（仅保留 TTL 内的）
  const storedReloadExpected = result[STORAGE_KEYS.DANMAKU_RELOAD_EXPECTED];
  if (storedReloadExpected && typeof storedReloadExpected === 'object') {
    await withStorageLock(async () => {
      let dirty = false;
      for (const [roomUrl, record] of Object.entries(storedReloadExpected)) {
        if (record && typeof record.at === 'number' && now - record.at < DANMAKU_HEALTH.RELOAD_EXPECTED_TTL_MS) {
          if (!state.danmakuReloadExpected.has(roomUrl)) {
            state.danmakuReloadExpected.set(roomUrl, record);
          }
        } else {
          dirty = true;
        }
      }
      if (dirty) {
        await chrome.storage.local.set({
          [STORAGE_KEYS.DANMAKU_RELOAD_EXPECTED]: serializeReloadExpected(),
        });
      }
    });
  }

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
