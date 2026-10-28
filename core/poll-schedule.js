// core/poll-schedule.js
// 关注列表轮询 alarm 的创建 / 查询 / 清除（纯调度，不含业务逻辑）
//
// 为什么独立成文件：Options 页面需要展示"间隔 + 下次请求时间"，但不能直接
// import following-poll.js —— 那条依赖链会一并加载 recording.js、danmaku-session.js，
// 而这些模块在模块求值阶段就注册了 chrome.alarms / event-bus 监听器，
// 会在普通页面上下文里凭空跑起来。

import { POLL_INTERVAL_MINUTES } from './config.js';
import { POLL_ALARM_NAME } from '../lib/constants.js';

/** 读取 alarm（Promise 包装，兼容只支持回调的 Chrome 版本） */
function getAlarm(name) {
  return new Promise((resolve) => chrome.alarms.get(name, resolve));
}

/**
 * 创建 / 重建关注列表轮询 alarm。
 * chrome.alarms.create 对同名 alarm 是幂等的，且重建会把下次触发时间重置为
 * now + periodInMinutes —— 手动检测后调用它即可让 interval 从此刻重新计时。
 */
export function createPollAlarm() {
  chrome.alarms.create(POLL_ALARM_NAME, {
    periodInMinutes: POLL_INTERVAL_MINUTES,
  });
}

/** 清除轮询 alarm（手动立即检测前暂停周期任务） */
export function clearPollAlarm() {
  return new Promise((resolve) =>
    chrome.alarms.clear(POLL_ALARM_NAME, resolve)
  );
}

/**
 * 查询轮询调度信息，供 Options 页面展示。
 * scheduledTime 是 alarm 的下次触发时间；真实 HTTP 请求还会在其后加 2~6s
 * 随机延迟（手动检测除外），所以它代表"下次开始检测"的时刻。
 */
export async function getPollSchedule() {
  const alarm = await getAlarm(POLL_ALARM_NAME);
  return {
    active: Boolean(alarm),
    intervalMinutes: POLL_INTERVAL_MINUTES,
    intervalSeconds: Math.round(POLL_INTERVAL_MINUTES * 60),
    scheduledTime: alarm?.scheduledTime || null,
  };
}
