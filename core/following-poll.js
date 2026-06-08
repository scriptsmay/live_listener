// core/following-poll.js
// 关注列表轮询、开播检测

import { getState, persistNotifiedRooms, persistActiveRecording, clearActiveRecording } from './state.js';
import { getConfig, POLL_INTERVAL_MINUTES, LIVING_API_URL } from './config.js';
import { fetchJson } from '../lib/http.js';
import { isEnvironmentRecording, sendToEnvironments } from './recording.js';

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
  targetEnvs
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
        .join(', ')}`
    );
    sendToEnvironments(targetEnvs, flvUrl, author.name, roomUrl, caption);
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
 */
export async function checkFollowingLivings() {
  try {
    const state = getState();
    const { monitorEnabled } = await chrome.storage.sync.get('monitorEnabled');
    if (monitorEnabled === false) return;

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
        return;
      }

      clearActiveRecording();
    }

    const { kuaishouVisited } =
      await chrome.storage.local.get('kuaishouVisited');
    if (!kuaishouVisited) return;

    const authors = new Set(enabledEnvs.flatMap((env) => getEnvAuthors(env)));
    if (!authors.size) return;

    // 随机延迟 2~6s，避免每次请求时间固定被风控
    await randomDelay(2000, 6000);

    console.log('[FollowingPoll] 查询关注列表，检测开播中...');
    const result = await fetchJson(LIVING_API_URL, {
      credentials: 'include',
    });

    if (!result.ok) {
      console.warn(`[FollowingPoll] 查询关注列表失败: ${result.status}`);
      setFollowReqStatus({ status: result.status, message: '请求失败' });
      return;
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
          targetEnvs
        );
      }
    }
    setFollowReqStatus({
      status: 200,
      message: '查询关注列表成功',
      onlineAuthors: onlineAuthors.join(','),
    });
  } catch (err) {
    console.warn('[FollowingPoll] 查询关注列表异常:', err);
  }
}

/**
 * 初始化 chrome.alarms 定时器
 * 注册 onInstalled 和 onAlarm 监听器
 */
export function initAlarms() {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create('pollFollowingLivings', {
      periodInMinutes: POLL_INTERVAL_MINUTES,
    });
    checkFollowingLivings();
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'pollFollowingLivings') checkFollowingLivings();
  });
}
