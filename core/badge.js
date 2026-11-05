// core/badge.js
// 图标徽章与"自动录制中"标记的统一管理
//
// 徽章语义（单一职责）：
//   HIGH —— 存在 status_ 录制中标记，即有自动录制任务在进行；
//   空   —— 没有自动录制任务。
// 录制的开始 / 结束 / 列表清空都必须经由本模块，避免各写各的导致状态残留
// （典型症状：录制已结束，HIGH 却一直挂着，只能手动"清空列表"才消失）。
//
// "是否在录制"以持久化的 status_ 标记为唯一事实源：markRecordingStarted 写入，
// finishRecording 清除。本模块不读 activeRecordingRoomUrl，避免受其写入时序、
// 单房间语义以及 monitorEnabled 门控的影响；不 import 任何 core 模块，
// 与 state.js / danmaku-session.js 之间没有循环依赖（只依赖 lib/）。
//
// 说明：旧实现在 Service Worker 恢复时按 streams 数量显示数字徽章，但
// stream-detector 平时检测流并不更新它，该数字只在冷启动后短暂出现，属遗留
// 的不一致行为。流列表信息由 Popup 完整承载，徽章统一只表示录制状态。

import {
  ACTIONS,
  RECORDING_STATUS_PREFIX,
  RECORDING_STATUS_VALUE,
  STORAGE_KEYS,
} from '../lib/constants.js';
import { fetchJson } from '../lib/http.js';

export const AUTO_RECORDING_BADGE = 'HIGH';

const BADGE_COLOR = '#ff5000';

// 录制刚启动时给后端一段落库 / 状态可见的宽限窗口：这段时间内不做
// "活跃列表为空即判定录制结束"的判定，避免刚亮起的 HIGH 被下一轮轮询误清。
// 取 90 秒覆盖 1 分钟 alarm 周期 + 后端建会话的余量。
const RECORDING_START_GRACE_MS = 90 * 1000;

function setBadge(text) {
  chrome.action.setBadgeText({ text });
  if (text) chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  return text;
}

async function readAll() {
  try {
    return (await chrome.storage.local.get(null)) || {};
  } catch (_) {
    return {};
  }
}

/** 筛出所有仍生效的 status_ 录制中标记键名 */
function recordingMarkerKeys(all) {
  return Object.keys(all).filter(
    (key) =>
      key.startsWith(RECORDING_STATUS_PREFIX) &&
      all[key] === RECORDING_STATUS_VALUE
  );
}

/**
 * 按当前 status_ 标记刷新徽章。
 * 供 Service Worker 状态恢复等"状态已变、只需同步显示"的场景使用。
 */
export async function refreshBadge() {
  const all = await readAll();
  return setBadge(recordingMarkerKeys(all).length ? AUTO_RECORDING_BADGE : '');
}

/**
 * 自动录制成功后调用：落盘"录制中"标记并置 HIGH 徽章。
 * status_ 标记同时供 Popup 渲染"✅ 录制中"按钮，streamUrl 是检测到的流地址。
 */
export async function markRecordingStarted(streamUrl) {
  await chrome.storage.local.set({
    [`${RECORDING_STATUS_PREFIX}${streamUrl}`]: RECORDING_STATUS_VALUE,
    [STORAGE_KEYS.RECORDING_BADGE_STARTED_AT]: Date.now(),
  });
  return setBadge(AUTO_RECORDING_BADGE);
}

/**
 * 录制结束 / 用户清空列表时调用：清除全部 status_ 标记并清空徽章，同时
 * 通知 Popup 重绘"✅ 录制中"按钮。幂等，可由多个检测点安全重复调用。
 *
 * 用 get(null) 扫描全部 key 而不是只删已知的 streamUrl：status_ 按流地址散落
 * 写入，录制结束的触发点未必持有当时的 streamUrl；全量清理还能抹掉历史遗留
 * 的孤儿标记，避免 Popup 永远显示"✅ 录制中"、徽章永远挂着 HIGH。
 *
 * 仅在确有标记被清除时才改动徽章与广播消息，避免录制刚启动时的并发竞态
 * 把新标记连同徽章一起清掉；force 用于"清空列表"这类需要无条件重置的场景。
 *
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<boolean>} 是否清理了录制标记
 */
export async function finishRecording({ force = false } = {}) {
  const all = await readAll();
  const keys = recordingMarkerKeys(all);
  if (!keys.length && !force) return false;
  if (keys.length) {
    try {
      await chrome.storage.local.remove([
        ...keys,
        STORAGE_KEYS.RECORDING_BADGE_STARTED_AT,
      ]);
    } catch (_) {}
  }
  setBadge('');
  try {
    chrome.runtime
      .sendMessage({ action: ACTIONS.RECORDING_ENDED })
      .catch(() => {});
  } catch (_) {}
  return true;
}

/**
 * 依据后端权威的"活跃录制列表"判定录制是否结束，并在结束时收尾徽章。
 *
 * 与弹幕同步用的 `active=true` 不同，这里必须带 `include_all=true`：默认查询
 * 只返回开启了扩展弹幕采集的房间，自动录制未必开启该开关，不带 include_all
 * 会把"仍在录制"误判成"已结束"从而错误清掉 HIGH。
 *
 * 仅在本地仍存在 status_ 标记时才发起查询：录制结束后标记即被清除，之后每轮
 * 轮询直接跳过，不产生额外请求。所有启用环境都查询失败时不改动任何状态，
 * 避免后端临时不可达时把正在录制的 HIGH 误清。
 *
 * @param {Array} environments - 环境配置（调用方负责筛出已启用的）
 * @returns {Promise<{checked: boolean, recording?: boolean}>}
 */
export async function syncRecordingBadge(environments) {
  if (!Array.isArray(environments) || !environments.length) {
    return { checked: false };
  }
  // 没有录制中标记：无事可做，避免每分钟空跑一轮状态接口
  const all = await readAll();
  if (!recordingMarkerKeys(all).length) {
    return { checked: false, recording: false };
  }

  // 刚启动的录制处于宽限窗口：后端房间状态可能还没在 active 列表里可见，
  // 此时按"空列表"判定会把刚亮起的 HIGH 误清，等下一轮再判。
  const startedAt = all[STORAGE_KEYS.RECORDING_BADGE_STARTED_AT];
  if (
    typeof startedAt === 'number' &&
    Date.now() - startedAt < RECORDING_START_GRACE_MS
  ) {
    return { checked: false, recording: true, withinGrace: true };
  }

  let anySucceeded = false;
  let activeRoomCount = 0;
  for (const env of environments) {
    if (!env.enabled || !env.statusApiUrl) continue;
    try {
      const sep = env.statusApiUrl.includes('?') ? '&' : '?';
      const result = await fetchJson(
        `${env.statusApiUrl}${sep}active=true&include_all=true`
      );
      if (result.ok && Array.isArray(result.data?.data?.rooms)) {
        anySucceeded = true;
        activeRoomCount += result.data.data.rooms.length;
      }
    } catch (_) {}
  }

  if (!anySucceeded) return { checked: false };

  if (activeRoomCount === 0) {
    await finishRecording();
    return { checked: true, recording: false };
  }
  return { checked: true, recording: true };
}
