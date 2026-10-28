// core/danmaku-session.js
// 弹幕会话管理、批量发送、录制状态轮询
//
// 弹幕聚合由 content.js（网页端，不会休眠）完成，
// Background 仅做无状态的"收到即转发"，规避 SW 休眠问题。
// 缓冲模式下的录制状态重试由 chrome.alarms 驱动（最小周期 1 分钟）。

import {
  getState,
  stateRestored,
  atomicSetAutoOpenedTab,
  atomicDeleteAutoOpenedTab,
  atomicMarkDanmakuRecoveryAttempt,
  atomicClearDanmakuRecovery,
  atomicMarkDanmakuReloadExpected,
  atomicIncrementDanmakuProbeFailure,
  atomicResetDanmakuProbeFailures,
  getDanmakuLastRecoveryAt,
  isDanmakuReloadExpected,
  atomicClearDanmakuReloadExpected,
} from './state.js';
import { getConfig, DANMAKU_BATCH_API_PATH } from './config.js';
import { fetchJson } from '../lib/http.js';
import { ACTIONS, DANMAKU_HEALTH } from '../lib/constants.js';
import { normalizeRoomUrl } from '../lib/url.js';
import { normalizeDanmakuBatch, filterDanmakuEvents } from '../danmaku/parser.js';
// 注意：MV3 Service Worker 禁止动态 import()，这里必须用静态导入。
// 与 recording.js 构成 ESM 循环依赖，但双方只在运行时事件回调里互相调用，
// 模块初始化阶段不触发，函数声明会被提升，因此运行时安全。
import { isEnvironmentRecording } from './recording.js';
import { autoDisableDanmakuIfIdle } from './danmaku-switch.js';

export const DANMAKU_MAX_BUFFER_SIZE = 5000; // 缓冲区最大事件数（防止内存泄漏）

const RETRY_ALARM_NAME = 'danmakuRetry';

// ===== 缓冲模式重试 alarm 生命周期 =====

/** 确保重试 alarm 存在（有缓冲会话时调用） */
function ensureDanmakuRetryAlarm() {
  chrome.alarms.get(RETRY_ALARM_NAME, (existing) => {
    if (!existing) {
      chrome.alarms.create(RETRY_ALARM_NAME, { periodInMinutes: 1 });
      console.log('[Danmaku] 已创建缓冲模式重试 alarm（1 分钟周期）');
    }
  });
}

/** 无缓冲会话时清除 alarm，避免空转 */
export function clearDanmakuRetryAlarmIfIdle() {
  const state = getState();
  // 只要还有任何会话（无论是否发送中），就保留 alarm 以检测录制启停状态变化
  if (state.danmakuSessions.size > 0) return;
  chrome.alarms.clear(RETRY_ALARM_NAME);
}

// 注册 alarm 监听器（模块加载时立即生效）
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RETRY_ALARM_NAME) return;
  const state = getState();
  for (const [roomUrl] of state.danmakuSessions) {
    // 检查所有会话：缓冲中的等待录制开始，发送中的等待录制结束
    checkRecordingAndUpdateSession(roomUrl).catch(() => {});
  }
  clearDanmakuRetryAlarmIfIdle();
});

// ===== 标签页管理 =====

/**
 * 恢复冷却判定（D3）。
 * 冷却期内禁止对该房间的一切探测与重载：页面加载期间 content script
 * 尚未就绪，sendMessage 必然失败，若继续探测会引发重载风暴。
 * @param {string} roomUrl
 * @param {number} [now]
 * @returns {boolean}
 */
function isRecoveryCoolingDown(roomUrl, now = Date.now()) {
  const last = getDanmakuLastRecoveryAt(roomUrl);
  return last > 0 && now - last < DANMAKU_HEALTH.RECOVERY_COOLDOWN_MS;
}

/**
 * 带超时的 tabs.sendMessage 封装。
 *
 * 显式传入回调时，Chrome 使用回调风格返回 undefined 并通过
 * chrome.runtime.lastError 报告"接收方不存在 / 通道关闭"；
 * 不传回调时返回 Promise。这里同时兼容两种形态，并以超时兜底
 * content script 卡死或无响应。
 * @returns {Promise<any|null>} 响应对象；失败/超时返回 null
 */
function sendMessageWithTimeout(tabId, message, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      const pending = chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) return finish(null);
        finish(response === undefined ? null : response);
      });
      if (pending && typeof pending.then === 'function') {
        pending.then(
          (response) => finish(response === undefined ? null : response),
          () => finish(null)
        );
      }
    } catch (_) {
      finish(null);
    }
  });
}

/**
 * 向标签页补发 start_danmaku（content 侧 startDanmakuCollection 幂等）。
 *
 * 不要求会话存在：恢复重载会短暂关闭弹幕开关，重载后的 content script
 * 依据 danmakuEnabled=false 不会自行启动，必须由扩展无条件补发一次。
 */
async function sendStartDanmaku(roomUrl, tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: ACTIONS.START_DANMAKU });
    console.log(`[Danmaku] 已向自动标签页补发 start_danmaku: ${roomUrl} (tabId=${tabId})`);
    return true;
  } catch (err) {
    // 页面仍在加载（content script 未就绪）时会走到这里，由重试链兜底
    return false;
  }
}

/**
 * 重载/新建标签页后，等待 content script 就绪并补发 start_danmaku。
 * setTimeout 在 SW 休眠时可能丢失，因此健康探测在恢复时间窗内也会补发。
 */
function scheduleStartDanmaku(roomUrl, tabId, attempt = 1) {
  const state = getState();

  // 同一房间只保留一条重试链（健康探测与 ensureDanmakuTab 可能同时触发）
  if (attempt === 1) {
    if (state.danmakuStartInFlight.has(roomUrl)) return;
    state.danmakuStartInFlight.add(roomUrl);
  }

  if (attempt > DANMAKU_HEALTH.RESUME_MAX_ATTEMPTS) {
    state.danmakuStartInFlight.delete(roomUrl);
    console.warn(`[Danmaku] 恢复后补发 start_danmaku 达到最大重试次数: ${roomUrl} (tabId=${tabId})`);
    return;
  }

  setTimeout(async () => {
    // 自动标签页映射已删除/变更，或房间正在关闭，则放弃本次恢复
    if (state.autoOpenedTabs.get(roomUrl) !== tabId) {
      state.danmakuStartInFlight.delete(roomUrl);
      return;
    }
    if (state.danmakuClosing.has(roomUrl)) {
      state.danmakuStartInFlight.delete(roomUrl);
      return;
    }

    const sent = await sendStartDanmaku(roomUrl, tabId);
    if (sent) {
      state.danmakuStartInFlight.delete(roomUrl);
    } else {
      scheduleStartDanmaku(roomUrl, tabId, attempt + 1);
    }
  }, DANMAKU_HEALTH.RESUME_RETRY_DELAY_MS);
}

/**
 * 创建自动标签页并持久化映射（并发去重）。
 *
 * recording.js 会在环境循环里并发调用 ensureDanmakuTab，同一房间可能在
 * 第一个 await 期间被创建两次并留下孤儿标签页。这里用
 * danmakuCreateInFlight 合并并发创建，并在创建完成后重新核对映射。
 * 创建不构成"重载风暴"（冷却锁约束的是 reload），因此不受冷却限制。
 *
 * @param {string} roomUrl
 * @returns {Promise<number|null>} 标签页 ID
 */
async function createAutoOpenedTab(roomUrl) {
  const state = getState();

  // 关闭流程优先：正在关闭的房间不得再新建标签页
  if (state.danmakuClosing.has(roomUrl)) return null;

  const inflight = state.danmakuCreateInFlight.get(roomUrl);
  if (inflight) return inflight;

  const task = (async () => {
    const knownTabId = state.autoOpenedTabs.get(roomUrl);
    if (knownTabId !== undefined) {
      try {
        await chrome.tabs.get(knownTabId);
        return knownTabId; // 已有存活标签页，避免重复创建
      } catch (_) {
        await atomicDeleteAutoOpenedTab(roomUrl);
      }
    }

    try {
      const tab = await chrome.tabs.create({ url: roomUrl, active: false });
      // 创建期间录制可能已结束：立即丢弃这个标签页，避免留下孤儿
      if (state.danmakuClosing.has(roomUrl)) {
        try {
          await chrome.tabs.remove(tab.id);
        } catch (_) {
          // 忽略
        }
        return null;
      }
      // chrome.tabs.create 返回后再次核对：并发路径可能已写入映射
      if (state.autoOpenedTabs.has(roomUrl)) {
        const existing = state.autoOpenedTabs.get(roomUrl);
        if (existing !== tab.id) {
          // 已有映射指向别的标签页，关闭本次多创建的标签页
          try {
            await chrome.tabs.remove(tab.id);
          } catch (_) {
            // 忽略
          }
          return existing;
        }
        return tab.id;
      }
      await atomicSetAutoOpenedTab(roomUrl, tab.id);
      console.log(`[Danmaku] 自动打开后台标签页: ${roomUrl} (tabId=${tab.id})`);
      return tab.id;
    } catch (err) {
      console.warn(`[Danmaku] 自动打开标签页失败: ${roomUrl}`, err.message);
      return null;
    }
  })();

  state.danmakuCreateInFlight.set(roomUrl, task);
  try {
    return await task;
  } finally {
    if (state.danmakuCreateInFlight.get(roomUrl) === task) {
      state.danmakuCreateInFlight.delete(roomUrl);
    }
  }
}

/**
 * 执行自动标签页恢复：重载已有标签页，或标签页已丢失时按 roomUrl 重建。
 *
 * 关键顺序（D3）：
 * 1. 先落盘 lastRecoveryAttemptAt 与"扩展主动重载"标记；
 * 2. 再调用 reload/update/create，页面 unload 触发的 danmaku_stop 会被忽略；
 * 3. 恢复完成后才允许关闭流程继续。
 *
 * @param {string} roomUrl
 * @param {number|null} existingTabId - 已知的标签页 ID；null 表示标签页已丢失
 * @returns {Promise<boolean>} 是否执行了恢复
 */
async function recoverAutoOpenedTab(roomUrl, existingTabId) {
  const state = getState();
  if (state.danmakuRecoveryPromises.has(roomUrl)) return false;
  if (state.danmakuClosing.has(roomUrl)) return false;

  const hasExistingTab = existingTabId !== null && existingTabId !== undefined;
  // 冷却期内禁止重载；但标签页已丢失时允许重建（不属于 reload 风暴）
  if (hasExistingTab && isRecoveryCoolingDown(roomUrl)) return false;
  // 映射已被删除或换成了别的标签页（例如期间录制结束），不要重载
  if (hasExistingTab && state.autoOpenedTabs.get(roomUrl) !== existingTabId) {
    return false;
  }

  const task = (async () => {
    try {
      // 先加锁再操作，顺序不可交换
      await atomicMarkDanmakuRecoveryAttempt(roomUrl, Date.now());
      await atomicMarkDanmakuReloadExpected(roomUrl, existingTabId);
      await atomicResetDanmakuProbeFailures(roomUrl);

      state.danmakuLastProbeAt.delete(roomUrl);

      let tabId = existingTabId;
      if (hasExistingTab) {
        try {
          // 标签页可能已被页面跳转到别处（如回到首页），此时 reload 只会重载
          // 错误页面，必须显式导航回目标直播间。
          const currentTab = await chrome.tabs.get(tabId);
          if (normalizeRoomUrl(currentTab?.url || '') !== roomUrl) {
            await chrome.tabs.update(tabId, { url: roomUrl });
            console.log(`[Danmaku] 自动标签页已偏离目标直播间，已重新导航: ${roomUrl} (tabId=${tabId})`);
          } else {
            await chrome.tabs.reload(tabId);
            console.log(`[Danmaku] 自动标签页健康检查失败，已重载: ${roomUrl} (tabId=${tabId})`);
          }
        } catch (err) {
          console.warn(`[Danmaku] 重载自动标签页失败，将重新创建: ${roomUrl}`, err.message);
          tabId = null;
          await atomicDeleteAutoOpenedTab(roomUrl);
        }
      }

      // 重载/导航期间若录制已结束（close 已执行），不要再重建
      if (state.danmakuClosing.has(roomUrl)) return false;

      if (tabId === null || tabId === undefined) {
        tabId = await createAutoOpenedTab(roomUrl);
        if (tabId === null) return false;
      }

      // 创建可能等待较久，关闭流程可能已完成
      if (state.danmakuClosing.has(roomUrl)) {
        try {
          await chrome.tabs.remove(tabId);
        } catch (_) {
          // 忽略
        }
        await atomicDeleteAutoOpenedTab(roomUrl);
        return false;
      }

      scheduleStartDanmaku(roomUrl, tabId);
      return true;
    } finally {
      if (state.danmakuRecoveryPromises.get(roomUrl) === task) {
        state.danmakuRecoveryPromises.delete(roomUrl);
      }
    }
  })();

  state.danmakuRecoveryPromises.set(roomUrl, task);
  return task;
}

/**
 * 探测单个自动标签页的健康状态（D3）。
 *
 * - 仅探测 autoOpenedTabs 中的标签页，用户手动打开的标签页永不探测/重载/关闭；
 * - 冷却期内直接跳过（不探测也不重载）；
 * - 消息无响应 / lastError / healthy=false 均计为失败，失败计数持久化，
 *   跨 SW 重启累计；连续失败达到阈值后触发恢复；
 * - 探测结果正常时重置失败计数，并在恢复时间窗内补发 start_danmaku。
 *
 * @param {string} roomUrl
 * @param {{force?: boolean}} [options] - force 跳过探测节流（ensureDanmakuTab 使用）
 * @returns {Promise<boolean>} 标签页是否健康
 */
export async function probeAutoOpenedTab(roomUrl, options = {}) {
  // 等待状态恢复完成：否则恢复前的探测会把"尚未恢复"当成"没有自动标签页"，
  // 或把空失败计数写回 storage 覆盖旧值。
  await stateRestored;
  const state = getState();
  const tabId = state.autoOpenedTabs.get(roomUrl);
  // 用户手动标签页 / 未打开自动标签页：不介入
  if (tabId === undefined) return false;
  // 正在关闭的房间不再探测，避免与关闭流程竞争
  if (state.danmakuClosing.has(roomUrl)) return false;

  const now = Date.now();
  if (isRecoveryCoolingDown(roomUrl, now)) return false;

  if (!options.force) {
    const lastProbe = state.danmakuLastProbeAt.get(roomUrl) || 0;
    if (now - lastProbe < DANMAKU_HEALTH.PROBE_INTERVAL_MS) return false;
  }
  state.danmakuLastProbeAt.set(roomUrl, now);

  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_) {
    tab = null; // 标签页已被关闭
  }

  const report = tab
    ? await sendMessageWithTimeout(
        tabId,
        { action: ACTIONS.DANMAKU_HEALTH_CHECK, roomUrl },
        DANMAKU_HEALTH.PROBE_TIMEOUT_MS
      )
    : null;

  if (report && report.healthy === true) {
    await atomicResetDanmakuProbeFailures(roomUrl);
    // 恢复时间窗内正常响应：补发 start_danmaku，覆盖 SW 休眠导致重试链中断的情况
    const recoveredAt = getDanmakuLastRecoveryAt(roomUrl);
    const resumeKey = `${roomUrl}|${recoveredAt}`;
    if (
      recoveredAt > 0 &&
      Date.now() - recoveredAt < DANMAKU_HEALTH.RESUME_RESEND_WINDOW_MS &&
      !state.danmakuResumeResent.has(resumeKey)
    ) {
      state.danmakuResumeResent.add(resumeKey);
      scheduleStartDanmaku(roomUrl, tabId);
    }
    return true;
  }

  // 失败计数持久化：SW 在两次 alarm 之间被销毁也不会丢
  const failures = await atomicIncrementDanmakuProbeFailure(roomUrl);
  console.warn(
    `[Danmaku] 自动标签页健康检查失败 (${failures}/${DANMAKU_HEALTH.PROBE_FAILURE_THRESHOLD}): ${roomUrl} (tabId=${tabId})`,
    report
      ? {
          isLiveRoom: report.isLiveRoom,
          hasActiveVideo: report.hasActiveVideo,
          hasEndOverlay: report.hasEndOverlay,
        }
      : '无响应'
  );

  const shouldRecover = tab === null || failures >= DANMAKU_HEALTH.PROBE_FAILURE_THRESHOLD;
  if (shouldRecover) {
    await recoverAutoOpenedTab(roomUrl, tab ? tabId : null);
  }
  return false;
}

/**
 * 录制确认后确保弹幕采集标签页可用（D3 扩展）。
 *
 * 与旧实现不同：已有标签页不再直接复用，而是先做健康探测。
 * - 健康：补发 start_danmaku（幂等），确保采集真正在跑；
 * - 不健康：交给探测/恢复流程。探测失败只累计计数，连续失败达到
 *   PROBE_FAILURE_THRESHOLD 才重载，与后台探测共用同一套阈值与冷却；
 * - 无标签页：新建并持久化映射（先armed 冷却，避免加载期误重载）。
 */
export async function ensureDanmakuTab(roomUrl) {
  await stateRestored;
  const state = getState();
  if (state.danmakuClosing.has(roomUrl)) return;

  const existingTabId = state.autoOpenedTabs.get(roomUrl);

  if (existingTabId !== undefined) {
    let tab = null;
    try {
      tab = await chrome.tabs.get(existingTabId);
    } catch (_) {
      tab = null;
    }

    if (!tab) {
      // 标签页已丢失：不是 reload，重建不受冷却限制，但仍要先记录恢复时间
      await atomicMarkDanmakuRecoveryAttempt(roomUrl, Date.now());
      await atomicDeleteAutoOpenedTab(roomUrl);
      if (state.danmakuClosing.has(roomUrl)) return;
      const tabId = await createAutoOpenedTab(roomUrl);
      if (tabId !== null) scheduleStartDanmaku(roomUrl, tabId);
      return;
    }

    // 直接复用探测/阈值/冷却逻辑，避免"单次失败即重载"与后台策略不一致
    const healthy = await probeAutoOpenedTab(roomUrl, { force: true });
    if (healthy) {
      const sent = await sendStartDanmaku(roomUrl, existingTabId);
      if (!sent) scheduleStartDanmaku(roomUrl, existingTabId);
    }
    return;
  }

  // 无自动标签页：新建。先记录恢复时间戳，使随后 30s 内的探测
  // 不会因页面加载期消息未就绪而误触发重载。
  await atomicMarkDanmakuRecoveryAttempt(roomUrl, Date.now());
  if (state.danmakuClosing.has(roomUrl)) return;
  const tabId = await createAutoOpenedTab(roomUrl);
  if (tabId !== null) scheduleStartDanmaku(roomUrl, tabId);
}

/**
 * 录制结束后自动关闭扩展打开的后台标签页
 * 用户手动打开的标签页不受影响
 *
 * 与恢复流程互斥：先置 closing 标记阻止新恢复启动，再等待进行中的恢复
 * 结束，最后才删除映射并关闭。否则恢复可能在录制结束后把标签页重新
 * 拉起来，留下永远不会被关闭的孤儿标签页。
 */
export async function closeAutoOpenedTab(roomUrl) {
  await stateRestored;
  const state = getState();

  state.danmakuClosing.add(roomUrl);
  try {
    // 等待进行中的建标签页与恢复流程，避免关闭后它们又把标签页拉起来
    const createInflight = state.danmakuCreateInFlight.get(roomUrl);
    if (createInflight) {
      await createInflight.catch(() => {});
    }
    const inflight = state.danmakuRecoveryPromises.get(roomUrl);
    if (inflight) {
      await inflight.catch(() => {});
    }

    // 关闭期间可能被恢复流程改写过映射，取最新值
    const tabId = state.autoOpenedTabs.get(roomUrl);
    await atomicDeleteAutoOpenedTab(roomUrl);
    await atomicClearDanmakuRecovery(roomUrl);
    state.danmakuLastProbeAt.delete(roomUrl);
    state.danmakuStartInFlight.delete(roomUrl);

    if (tabId === undefined) return;
    try {
      await chrome.tabs.remove(tabId);
      console.log(`[Danmaku] 录制结束，已关闭自动标签页: ${roomUrl} (tabId=${tabId})`);
    } catch (_) {
      // 标签页可能已被用户手动关闭
    }
  } finally {
    state.danmakuClosing.delete(roomUrl);
  }
}

// ===== 会话生命周期 =====

/**
 * 启动弹幕会话（仅创建缓冲，不立即发送）
 * isSending 标记是否正在向后端发送弹幕（需录制中才开启）
 */
export function startDanmakuSession(roomUrl, sessionStartMs, tabId, url, title) {
  const state = getState();
  state.danmakuSessions.set(roomUrl, {
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
  state.danmakuBatchBuffer.set(roomUrl, []);
  console.log(`[Danmaku] 采集会话已创建（等待录制）: ${roomUrl}`);
  ensureDanmakuRetryAlarm();
}

/**
 * 停止弹幕会话（先 drain 缓冲再 flush，最后清理）
 * @param {string} roomUrl - 直播间 URL
 * @param {boolean} forceFlush - 强制刷新剩余缓冲（录制结束时使用）
 */
export async function stopDanmakuSession(roomUrl, forceFlush = false) {
  const state = getState();
  const session = state.danmakuSessions.get(roomUrl);

  if (session) {
    console.log(
      `[Danmaku] 采集会话结束: ${roomUrl}, 共 ${session.eventCount} 条事件`
    );
    session.stopping = true;

    const buffer = state.danmakuBatchBuffer.get(roomUrl);
    const remaining = buffer ? buffer.splice(0) : [];
    session.eventCount += remaining.length;

    // forceFlush 时无论 isSending 状态如何都尝试发送缓冲区，
    // 避免页面刷新/卸载时因 isSending=false 丢弃已采集的弹幕数据。
    if (forceFlush && remaining.length > 0) {
      buffer.push(...remaining);
      // 临时开启发送以绕过 flushDanmakuBatch 的 isSending 门控
      const wasSending = session.isSending;
      session.isSending = true;
      await flushDanmakuBatch(roomUrl).catch((err) => {
        console.warn('[Danmaku] forceFlush 发送失败:', err.message);
      });
      session.isSending = wasSending;
    }

    state.danmakuSessions.delete(roomUrl);
    state.danmakuBatchBuffer.delete(roomUrl);
  } else {
    state.danmakuSessions.delete(roomUrl);
    state.danmakuBatchBuffer.delete(roomUrl);
  }

  // 若无活跃发送会话，自动关闭弹幕开关
  autoDisableDanmakuIfIdle();
  clearDanmakuRetryAlarmIfIdle();
}

/**
 * 处理 content.js 上报的 danmaku_stop（页面 unload）。
 *
 * 恢复流程主动重载标签页时，beforeunload 同样会触发 danmaku_stop。
 * 若照常销毁会话并 autoDisableDanmakuIfIdle()，danmakuEnabled 会被持久化为
 * false，重载后的 content script 不会自行启动采集，恢复动作反而让弹幕永久
 * 停摆。因此对于"扩展发起的重载/导航"（reloadExpected 标记）跳过清理，
 * 仅消费标记并在页面恢复后补发 start_danmaku。
 *
 * 但若标签页已导航到别的房间/页面（senderTabUrl 与 roomUrl 不一致），
 * 说明是真实离开，仍按正常流程清理。
 *
 * @param {string} roomUrl - 归一化后的直播间 URL
 * @param {{senderTabUrl?: string}} [context]
 * @returns {Promise<boolean>} true 表示本次 stop 被恢复流程忽略
 */
export async function handleDanmakuStopFromContent(roomUrl, context = {}) {
  if (!roomUrl) return false;
  // 重载标记可能在 restoreState 之前就被查询到，先等状态恢复
  await stateRestored;

  const tabNavigatedAway =
    typeof context.senderTabUrl === 'string' &&
    context.senderTabUrl !== '' &&
    normalizeRoomUrl(context.senderTabUrl) !== roomUrl;

  if (!tabNavigatedAway && isDanmakuReloadExpected(roomUrl)) {
    // 只消费一次：重载的 unload 消息过后标记即失效，
    // 之后用户手动离开该房间产生的 danmaku_stop 仍能正常清理。
    await atomicClearDanmakuReloadExpected(roomUrl);
    console.log(`[Danmaku] 忽略扩展重载引发的 danmaku_stop，保留会话与采集开关: ${roomUrl}`);

    // 卸载前尽力把缓冲刷给后端（与旧 reload 路径一致），避免页面重建后
    // startDanmakuSession 重置缓冲导致已采集弹幕丢失。
    const state = getState();
    const session = state.danmakuSessions.get(roomUrl);
    const buffer = state.danmakuBatchBuffer.get(roomUrl);
    if (session && buffer && buffer.length > 0) {
      const wasSending = session.isSending;
      session.isSending = true;
      await flushDanmakuBatch(roomUrl).catch(() => {});
      session.isSending = wasSending;
    }

    // 不在此处立即补发 start_danmaku：恢复流程已排好重试链，
    // 且页面就绪后的健康探测会在恢复窗口内无条件补发。
    return true;
  }

  // 真实离开：清掉残留标记并按原逻辑收尾
  await atomicClearDanmakuReloadExpected(roomUrl);
  await stopDanmakuSession(roomUrl, true);
  return false;
}

// ===== 弹幕发送 =====

/**
 * 刷新指定房间的弹幕缓冲到后端
 * 仅在 isSending=true 时才实际发送，否则保留在缓冲区
 */
export async function flushDanmakuBatch(roomUrl) {
  const state = getState();
  const buffer = state.danmakuBatchBuffer.get(roomUrl);
  const session = state.danmakuSessions.get(roomUrl);
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
  //
  // 只要有任意一个环境判定为"应保留缓冲"（后端无活跃录制会话 / 网络失败），
  // 就把本批事件放回缓冲区头部，避免静默丢数据。
  // 背景：events 在上面已被 splice 取空，若此处不回填，
  // 后端返回 no_active_session（历史上还是 HTTP 200）时弹幕会凭空消失。
  let shouldRequeue = false;
  try {
    const config = await getConfig();
    for (const env of config.environments) {
      if (!env.enabled) continue;
      try {
        const result = await fetchJson(
          env.danmakuBatchApiUrl || `${env.baseUrl}${DANMAKU_BATCH_API_PATH}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              room_url: roomUrl,
              events: filtered,
              session_start_ms: session.sessionStartMs,
              title: session.title || '',
            }),
          }
        );
        // 后端无活跃录制会话：数据未落盘，必须保留缓冲等待录制启动后重发。
        // 兼容新旧后端：新版返回 HTTP 409，旧版返回 HTTP 200 + error 字段。
        if (result.data?.error === 'no_active_session' || result.status === 409) {
          shouldRequeue = true;
          console.warn(
            `[Danmaku] ${env.name} 后端无活跃录制会话，${filtered.length} 条弹幕保留缓冲等待重发: ${roomUrl}`
          );
        } else if (!result.ok) {
          shouldRequeue = true;
          console.warn(
            `[Danmaku] ${env.name} 批量发送返回 HTTP ${result.status}，保留缓冲待重试`
          );
        }
      } catch (err) {
        shouldRequeue = true;
        console.warn(`[Danmaku] 批量发送到 ${env.name} 失败:`, err.message);
      }
    }
  } catch (err) {
    shouldRequeue = true;
    console.warn('[Danmaku] 批量发送失败:', err.message);
  }

  if (shouldRequeue) {
    // 回填到缓冲区头部，保持时间顺序；eventCount 是"已采集"计数，需扣回避免重复累计
    buffer.unshift(...events);
    session.eventCount -= events.length;
    trimDanmakuBuffer(buffer);
  }
}

/** 缓冲区溢出时丢弃最早事件，防止长时间不录制导致内存泄漏 */
function trimDanmakuBuffer(buffer) {
  if (buffer.length > DANMAKU_MAX_BUFFER_SIZE) {
    const dropped = buffer.length - DANMAKU_MAX_BUFFER_SIZE;
    buffer.splice(0, dropped);
    console.warn(`[Danmaku] 缓冲区超过 ${DANMAKU_MAX_BUFFER_SIZE}，丢弃最早 ${dropped} 条`);
  }
}

// ===== 录制状态联动 =====

/**
 * 检查指定房间的录制状态，并自动启停弹幕发送
 * @returns {Promise<boolean>} 当前是否正在发送
 */
export async function checkRecordingAndUpdateSession(roomUrl) {
  const state = getState();
  const session = state.danmakuSessions.get(roomUrl);
  if (!session) return false;

  session.lastRecordingCheckAt = Date.now();

  const config = await getConfig();
  let isRecording = false;
  let checkedEnvCount = 0;
  for (const env of config.environments) {
    if (!env.enabled) continue;
    checkedEnvCount++;
    try {
      if (await isEnvironmentRecording(env, roomUrl)) {
        isRecording = true;
        break;
      }
    } catch (err) {
      // 不要静默吞掉：网络/权限/超时失败会让 isSending 永远上不来
      console.warn(
        `[Danmaku] 录制状态查询失败 [${env.name}] ${env.statusApiUrl}?url=${roomUrl}:`,
        err.message
      );
    }
  }
  if (checkedEnvCount === 0) {
    console.warn('[Danmaku] 没有已启用的环境，无法查询录制状态，弹幕将持续缓冲');
  }

  if (isRecording && !session.isSending) {
    session.isSending = true;
    console.log(`[Danmaku] 录制中，开始发送弹幕: ${roomUrl}`);
    await flushDanmakuBatch(roomUrl).catch(() => {});
    clearDanmakuRetryAlarmIfIdle();
  } else if (!isRecording && session.isSending) {
    console.log(`[Danmaku] 录制已结束，停止发送弹幕: ${roomUrl}`);
    await flushDanmakuBatch(roomUrl).catch(() => {});
    session.isSending = false;
    await closeAutoOpenedTab(roomUrl);
  }

  // 后端确认录制中时，顺带做一次节流的自动标签页健康探测（D3）。
  // 覆盖状态轮询漏掉短暂 idle 的情况：页面已关播但 isSending 仍为 true 时，
  // 下一次正向状态检查仍会发现没有可用 video 并触发恢复。
  // probeAutoOpenedTab 内部已做 PROBE_INTERVAL_MS 节流与冷却判定，
  // 无需在此重复计算；用户手动标签页不会被探测。
  if (isRecording) {
    await probeAutoOpenedTab(roomUrl).catch((err) => {
      console.warn(`[Danmaku] 自动标签页健康探测异常: ${roomUrl}`, err.message);
    });
  }

  // 网络 await 期间会话可能已被 stop，重新检查
  if (!state.danmakuSessions.has(roomUrl)) return false;
  return session.isSending;
}

// ===== 录制请求联动 =====

/**
 * 录制请求成功后，立即激活该房间的弹幕发送
 * 跳过等待录制状态轮询，消除最多 10 秒的发送延迟
 */
export function activateDanmakuForRoom(roomUrl) {
  const state = getState();
  const session = state.danmakuSessions.get(roomUrl);
  if (!session || session.isSending || session.stopping) return;
  session.isSending = true;
  console.log(`[Danmaku] 录制请求已确认，立即开启弹幕发送: ${roomUrl}`);
}

/**
 * 录制被后端拒绝时，停止该房间的弹幕发送
 */
export function deactivateDanmakuForRoom(roomUrl) {
  const state = getState();
  const session = state.danmakuSessions.get(roomUrl);
  if (!session || !session.isSending) return;
  session.isSending = false;
  console.log(`[Danmaku] 录制被拒绝，停止弹幕发送: ${roomUrl}`);
}

// ===== 弹幕批次处理（由 message-router 调用） =====

/**
 * 处理来自 content.js 的弹幕批次消息
 * 如果会话不存在则自动创建；缓冲事件并立即尝试 flush
 */
export async function handleDanmakuBatch(roomUrl, events, sessionStartMs, tabId, title) {
  const state = getState();

  // 如果会话不存在，自动创建
  if (!state.danmakuSessions.has(roomUrl)) {
    startDanmakuSession(roomUrl, sessionStartMs || Date.now(), tabId, roomUrl, title || '');
    checkRecordingAndUpdateSession(roomUrl).catch((err) => {
      console.warn('[Danmaku] handleDanmakuBatch 首次状态检查失败:', err.message);
    });
  }

  const session = state.danmakuSessions.get(roomUrl);
  const buffer = state.danmakuBatchBuffer.get(roomUrl);

  // 跳过正在停止的会话
  if (session?.stopping) return;

  if (buffer && Array.isArray(events)) {
    buffer.push(...events);
    trimDanmakuBuffer(buffer);
  }

  // 收到即转发：立即尝试 flush（无状态，不依赖定时器）
  flushDanmakuBatch(roomUrl).catch(() => {});
}

// ===== 手动重试 =====

/**
 * 手动重试所有缓冲模式会话的录制状态检查（供 Popup 紧急恢复使用）
 * @returns {Promise<{retried: number, activated: number}>}
 */
export async function retryAllBufferingSessions() {
  const state = getState();
  let retried = 0;
  let activated = 0;
  for (const [roomUrl, session] of state.danmakuSessions) {
    if (!session.isSending && !session.stopping) {
      retried++;
      session.lastRecordingCheckAt = 0; // 重置时间戳，强制立即检查
      const wasSending = session.isSending;
      await checkRecordingAndUpdateSession(roomUrl).catch(() => {});
      if (!wasSending && session.isSending) activated++;
    }
  }
  return { retried, activated };
}

// ===== 状态查询 =====

/**
 * 获取所有弹幕会话的状态快照（供 Popup 查询）
 */
export function getDanmakuStatus() {
  const state = getState();
  const sessions = [];
  for (const [roomUrl, session] of state.danmakuSessions) {
    const buffer = state.danmakuBatchBuffer.get(roomUrl) || [];
    sessions.push({
      roomUrl,
      title: session.title || '',
      isSending: session.isSending,
      stopping: session.stopping,
      eventCount: session.eventCount,
      bufferSize: buffer.length,
      startedAt: session.startedAt,
      sessionStartMs: session.sessionStartMs,
      hasAutoTab: state.autoOpenedTabs.has(roomUrl),
    });
  }
  return sessions;
}
