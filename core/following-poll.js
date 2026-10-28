// core/following-poll.js
// 关注列表轮询、开播检测

import {
  getState,
  persistNotifiedRooms,
  persistActiveRecording,
  clearActiveRecording,
} from './state.js';
import { getConfig, LIVING_API_URL } from './config.js';
import { fetchJson } from '../lib/http.js';
import { isEnvironmentRecording, sendToEnvironments } from './recording.js';
import { POLL_ALARM_NAME } from '../lib/constants.js';
import { createPollAlarm, clearPollAlarm } from './poll-schedule.js';

// 同一时刻只允许一次关注列表查询在跑。
// 手动检测会在 alarm 触发的随机延迟窗口内插入，若不串行化，两次查询会并发
// 命中快手接口（风控）并让 notifiedRooms 的去重语义失效。
let _checkInFlight = null;

// ===== 内部辅助 =====

function getEnvAuthors(env) {
  return Array.isArray(env.followedAuthors) ? env.followedAuthors : [];
}

function getEnabledEnvironments(config) {
  return config.environments.filter((env) => env.enabled);
}

function randomDelay(min, max) {
  return new Promise((resolve) =>
    setTimeout(resolve, Math.random() * (max - min) + min)
  );
}

/**
 * 存储上次请求关注列表的结果
 */
export function setFollowReqStatus(statusResult) {
  chrome.storage.local.set({
    lastReqStatus: {
      time: Date.now(),
      result: statusResult,
    },
  });
}

function pickBestQuality(representations) {
  let best = null;
  let bestLevel = -1;
  for (const rep of representations) {
    if ((rep.level || 0) > bestLevel) {
      bestLevel = rep.level;
      best = rep;
    }
  }
  console.log('[FollowingPoll] Best quality:', bestLevel);
  return best?.url || representations[0]?.url || '';
}

async function handleStreamerOnline(
  author,
  roomId,
  playUrls,
  caption = '',
  targetEnvs,
  coverUrl = ''
) {
  const state = getState();
  const roomUrl = `https://live.kuaishou.com/u/${author.id}`;

  let flvUrl = '';
  for (const p of playUrls) {
    if (p.adaptationSet?.representation?.length) {
      flvUrl = pickBestQuality(p.adaptationSet.representation);
      break;
    }
  }

  console.log(
    `[FollowingPoll] 主播 ${author.name} 开播了，[${caption}]，直播间: ${roomUrl}, FLV地址: ${flvUrl}`
  );

  if (flvUrl) {
    console.log(
      `[FollowingPoll] ${author.name} 自动发送直播流到 ${targetEnvs
        .map((env) => env.name)
        .join(', ')}，封面: ${coverUrl || '无'}`
    );
    sendToEnvironments(
      targetEnvs,
      flvUrl,
      author.name,
      roomUrl,
      caption,
      coverUrl
    );
  } else {
    console.log(
      `[FollowingPoll] ${author.name} 无流地址，尝试打开直播间页面让 webRequest 捕获`
    );
  }

  if (state.notifiedRooms.has(roomId)) return;
  state.notifiedRooms.add(roomId);
  persistNotifiedRooms(state.notifiedRooms);
  chrome.storage.local.set({ [`notify_${roomId}`]: roomUrl });
}

/**
 * 检查关注的主播是否正在直播
 *
 * 执行流程：
 * 1. 检查监控是否启用
 * 2. 如果已有录制中的目标直播间，检查各环境后端录制状态
 * 3. 检查是否访问过快手页面
 * 4. 获取已启用环境的关注主播列表
 * 5. 添加随机延迟防风控
 * 6. 请求快手关注列表 API
 * 7. 遍历直播列表，按环境匹配关注的主播，触发录制处理
 *
 * @param {{ manual?: boolean }} [options] manual 为 true 时来自 Popup 的
 *   "立即检测"：跳过监控开关判定与防风控随机延迟，用户点了就要立刻看到结果。
 * @returns {Promise<{ ran: boolean, reason?: string, onlineAuthors?: string[] }>}
 *   ran 为 false 表示因前置条件不满足而没有真正请求快手接口，reason 说明原因。
 */
export function checkFollowingLivings({ manual = false } = {}) {
  if (_checkInFlight) {
    // 已有查询在跑：直接复用它的结果，而不是并发再打一次快手接口。
    // 对 manual 调用方同样适用 —— 那次查询拿到的就是最新列表。
    console.log('[FollowingPoll] 上一次关注列表查询尚未结束，复用其结果');
    return _checkInFlight.then((result) => ({ ...result, coalesced: true }));
  }
  _checkInFlight = runFollowingCheck({ manual }).finally(() => {
    _checkInFlight = null;
  });
  return _checkInFlight;
}

async function runFollowingCheck({ manual }) {
  try {
    const state = getState();
    if (!manual) {
      const { monitorEnabled } =
        await chrome.storage.sync.get('monitorEnabled');
      if (monitorEnabled === false) return { ran: false, reason: 'disabled' };
    }

    const config = await getConfig();
    const enabledEnvs = getEnabledEnvironments(config);

    if (state.activeRecordingRoomUrl) {
      let anyRecording = false;
      for (const env of enabledEnvs) {
        try {
          if (await isEnvironmentRecording(env, state.activeRecordingRoomUrl)) {
            anyRecording = true;
            break;
          }
        } catch (err) {
          console.warn(`[FollowingPoll][${env.name}] 录制状态查询失败:`, err);
        }
      }

      if (anyRecording) {
        console.log('[FollowingPoll] 仍在录制中，跳过关注列表查询');
        return { ran: false, reason: 'recording' };
      }

      clearActiveRecording();
    }

    const { kuaishouVisited } =
      await chrome.storage.local.get('kuaishouVisited');
    if (!kuaishouVisited) return { ran: false, reason: 'no_kuaishou_cookie' };

    const authors = new Set(enabledEnvs.flatMap((env) => getEnvAuthors(env)));
    if (!authors.size) return { ran: false, reason: 'no_authors' };

    // 随机延迟 2~6s，避免每次请求时间固定被风控。
    // 手动检测是用户显式动作，且点击本身不具周期性，不需要该延迟。
    if (!manual) await randomDelay(2000, 6000);

    console.log('[FollowingPoll] 查询关注列表，检测开播中...');
    const result = await fetchJson(LIVING_API_URL, {
      credentials: 'include',
    });

    if (!result.ok) {
      console.warn(`[FollowingPoll] 查询关注列表失败: ${result.status}`);
      setFollowReqStatus({ status: result.status, message: '请求失败' });
      return { ran: true, reason: 'request_failed' };
    }
    const data = result.data || {};
    const list = data?.data?.list || [];

    const onlineAuthors = [];
    for (const item of list) {
      const author = item?.author;
      if (!author) continue;
      if (authors.has(author.name)) {
        const targetEnvs = enabledEnvs.filter((env) =>
          getEnvAuthors(env).includes(author.name)
        );
        if (!targetEnvs.length) continue;
        console.log(
          `[FollowingPoll] 检测到关注的主播开播: ${author.name}，匹配环境: ${targetEnvs
            .map((env) => env.name)
            .join(', ')}`
        );
        onlineAuthors.push(author.name);
        handleStreamerOnline(
          author,
          item.id,
          item.playUrls || [],
          item.caption,
          targetEnvs,
          item.poster || ''
        );
      }
    }
    setFollowReqStatus({
      status: 200,
      message: '查询关注列表成功',
      onlineAuthors: onlineAuthors.join(','),
    });
    return { ran: true, onlineAuthors };
  } catch (err) {
    console.warn('[FollowingPoll] 查询关注列表异常:', err);
    return { ran: false, reason: 'error' };
  }
}

/**
 * 初始化 chrome.alarms 定时器
 *
 * 关键点：alarm.create 必须在每次 SW 启动时无条件执行一次，而不能只放在
 * onInstalled 回调里。原因：onInstalled 仅在首次安装/扩展更新/Chrome 升级
 * 时触发，如果 alarm 因任何原因（用户清缓存、扩展被禁用再启用、SW 异常等）
 * 丢失后不会自愈。alarms.create 对同名 alarm 是幂等的，重复调用安全。
 *
 * 另：onInstalled 首次跑一次 checkFollowingLivings()，避免刚装完等 1 分钟
 * 才看到首屏数据。
 */
export function initAlarms() {
  // 每次 SW 启动都重建 alarm（根因修复：解决 alarm 静默丢失导致停止轮询）
  createPollAlarm();

  chrome.runtime.onInstalled.addListener(() => {
    // 首次安装/更新时立即跑一次，不用等下一分钟
    checkFollowingLivings();
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === POLL_ALARM_NAME) checkFollowingLivings();
  });
}

/**
 * 手动立即检测（Popup「立即检测」按钮）
 *
 * 语义：取消当前 interval 计时 → 立刻请求一次关注列表 → 重新开始 interval。
 * 实现上先 clear 再 create：clear 保证此刻不会有一个到点的 alarm 与手动查询
 * 并发（配合 checkFollowingLivings 的串行守卫），create 把下次触发时间重置为
 * now + periodInMinutes，等效于"从这次手动检测重新计时"。
 * 清空 notifiedRooms 是因为手动检测的意图是"重新过一遍开播列表"，
 * 否则已被通知过的房间只会重发流地址、不会重新触发通知。
 * 注意不要同时清 activeRecordingRoomUrl：它记录的是真实录制状态，
 * 清掉会让下一轮 alarm 丢失"正在录制"的短路，多打一次快手接口。
 *
 * @returns {Promise<{ran: boolean, reason?: string, onlineAuthors?: string[]}>}
 */
export async function checkFollowingNow() {
  await clearPollAlarm();
  createPollAlarm();

  const state = getState();
  state.notifiedRooms.clear();
  await chrome.storage.local.remove('notifiedRooms');

  return checkFollowingLivings({ manual: true });
}
