// core/danmaku-session.js
// 弹幕会话管理、批量发送、录制状态轮询
//
// 弹幕聚合由 content.js（网页端，不会休眠）完成，
// Background 仅做无状态的"收到即转发"，规避 SW 休眠问题。
// 缓冲模式下的录制状态重试由 chrome.alarms 驱动（最小周期 1 分钟）。

import { getState } from './state.js';
import { getConfig, DANMAKU_BATCH_API_PATH } from './config.js';
import { fetchJson } from '../lib/http.js';
import { normalizeDanmakuBatch, filterDanmakuEvents } from '../danmaku/parser.js';

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
  const hasBuffering = [...state.danmakuSessions.values()].some(
    (s) => !s.isSending && !s.stopping
  );
  if (!hasBuffering) {
    chrome.alarms.clear(RETRY_ALARM_NAME);
  }
}

// 注册 alarm 监听器（模块加载时立即生效）
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RETRY_ALARM_NAME) return;
  const state = getState();
  for (const [roomUrl, session] of state.danmakuSessions) {
    if (!session.isSending && !session.stopping) {
      checkRecordingAndUpdateSession(roomUrl).catch(() => {});
    }
  }
  clearDanmakuRetryAlarmIfIdle();
});

// ===== 标签页管理 =====

/**
 * 录制确认后自动打开后台标签页，确保弹幕采集脚本能注入
 * 如果该房间已有打开的标签页，不会重复创建
 */
export async function ensureDanmakuTab(roomUrl) {
  const state = getState();
  if (state.autoOpenedTabs.has(roomUrl)) {
    const existingTabId = state.autoOpenedTabs.get(roomUrl);
    try {
      await chrome.tabs.get(existingTabId);
      return; // 标签页仍存在，无需重复打开
    } catch (_) {
      state.autoOpenedTabs.delete(roomUrl);
    }
  }

  try {
    const tab = await chrome.tabs.create({ url: roomUrl, active: false });
    state.autoOpenedTabs.set(roomUrl, tab.id);
    console.log(`[Danmaku] 自动打开后台标签页: ${roomUrl} (tabId=${tab.id})`);
  } catch (err) {
    console.warn(`[Danmaku] 自动打开标签页失败: ${roomUrl}`, err.message);
  }
}

/**
 * 录制结束后自动关闭扩展打开的后台标签页
 * 用户手动打开的标签页不受影响
 */
export async function closeAutoOpenedTab(roomUrl) {
  const state = getState();
  const tabId = state.autoOpenedTabs.get(roomUrl);
  if (tabId === undefined) return;

  state.autoOpenedTabs.delete(roomUrl);
  try {
    await chrome.tabs.remove(tabId);
    console.log(`[Danmaku] 录制结束，已关闭自动标签页: ${roomUrl} (tabId=${tabId})`);
  } catch (_) {
    // 标签页可能已被用户手动关闭
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

    if (forceFlush && session.isSending && remaining.length > 0) {
      buffer.push(...remaining);
      await flushDanmakuBatch(roomUrl).catch(() => {});
    }

    state.danmakuSessions.delete(roomUrl);
    state.danmakuBatchBuffer.delete(roomUrl);
  } else {
    state.danmakuSessions.delete(roomUrl);
    state.danmakuBatchBuffer.delete(roomUrl);
  }

  // 若无活跃发送会话，自动关闭弹幕开关（延迟导入避免循环依赖）
  const { autoDisableDanmakuIfIdle } = await import('./danmaku-switch.js');
  autoDisableDanmakuIfIdle();
  clearDanmakuRetryAlarmIfIdle();
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
  try {
    const config = await getConfig();
    for (const env of config.environments) {
      if (!env.enabled) continue;
      try {
        await fetchJson(
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
      } catch (err) {
        console.warn(`[Danmaku] 批量发送到 ${env.name} 失败:`, err.message);
      }
    }
  } catch (err) {
    console.warn('[Danmaku] 批量发送失败:', err.message);
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
  const { isEnvironmentRecording } = await import('./recording.js');
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
    checkRecordingAndUpdateSession(roomUrl).catch(() => {});
  }

  const session = state.danmakuSessions.get(roomUrl);
  const buffer = state.danmakuBatchBuffer.get(roomUrl);

  // 跳过正在停止的会话
  if (session?.stopping) return;

  if (buffer && Array.isArray(events)) {
    buffer.push(...events);
    // 防止缓冲区无限增长：超出上限时丢弃最早的事件
    if (buffer.length > DANMAKU_MAX_BUFFER_SIZE) {
      const dropped = buffer.length - DANMAKU_MAX_BUFFER_SIZE;
      buffer.splice(0, dropped);
      console.warn(
        `[Danmaku] 缓冲区溢出，丢弃 ${dropped} 条早期事件: ${roomUrl}`
      );
    }
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
