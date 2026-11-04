// core/xhs-live-discovery.js
// 小红书页面直播信息发现：匹配扩展设置中的监控主播，自动触发录制上报。
//
// 数据来源（content/inject.js 被动解析页面自身响应，不额外发请求）：
//   - 直播广场 squarefeed：tRoomInfo + tLiveHostInfo + link/flvUrl
//   - 搜索 onebox：user_one_box.live_info
//   - homefeed / feed：note.liveCard.live
//   - 直播间页面 __INITIAL_STATE__.liveStream：hostInfo.userId + roomInfo
//
// 匹配配置：每个环境独立的 xiaohongshuAuthors（见 core/xhs-authors.js）。

import { getState, persistNotifiedRooms } from './state.js';
import { getConfig } from './config.js';
import { normalizeRoomUrl } from '../lib/url.js';
import { buildXhsAuthorIndex, findTargetEnvironments } from './xhs-authors.js';
import { sendToEnvironments, cacheXhsLiveRoomHost } from './recording.js';

// 后端拒绝/网络失败后的重试间隔，避免页面每次 feed 响应都打一次后端
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

function buildRoomUrl(item) {
  return normalizeRoomUrl(
    item.roomUrl || `https://www.xiaohongshu.com/livestream/${item.roomId}`
  );
}

function buildTitle(item, roomUrl) {
  return (item.title || item.nickname || roomUrl).trim();
}

/**
 * 处理一批页面直播信息。
 * @param {Array<{
 *   platform?: string, live?: boolean, roomId?: string, userId?: string,
 *   redId?: string, nickname?: string, title?: string, streamUrl?: string,
 *   coverUrl?: string, roomUrl?: string
 * }>} items
 */
export async function handleXhsLiveInfo(items) {
  if (!Array.isArray(items) || items.length === 0) return;

  // 先无条件缓存「直播间 → 主播」映射：即使监听开关关闭、主播不在监控名单，
  // Popup 手动录制也需要它来补 host_user_id，避免按直播间地址重复建房间。
  for (const item of items) {
    if (item?.platform === 'xiaohongshu' && item.roomId && item.userId) {
      await cacheXhsLiveRoomHost(item.roomId, item.userId);
    }
  }

  const { monitorEnabled } = await chrome.storage.sync.get('monitorEnabled');
  if (monitorEnabled === false) return;

  const config = await getConfig();
  const enabledEnvs = config.environments.filter((env) => env.enabled);
  const index = buildXhsAuthorIndex(enabledEnvs);
  if (!index.length) return;

  const state = getState();

  if (state.xhsDiscoveryCooldown.size > 200) {
    const cutoff = Date.now() - FAILURE_COOLDOWN_MS;
    for (const [roomId, ts] of state.xhsDiscoveryCooldown) {
      if (ts < cutoff) state.xhsDiscoveryCooldown.delete(roomId);
    }
  }

  for (const item of items) {
    if (!item || item.platform !== 'xiaohongshu' || item.live === false) continue;
    if (!item.roomId || !item.streamUrl) continue;

    const targetEnvs = findTargetEnvironments(item, index);
    if (!targetEnvs.length) continue;

    const roomUrl = buildRoomUrl(item);
    const notifyKey = `xhs:${item.roomId}`;
    if (state.notifiedRooms.has(notifyKey) || state.xhsDiscoveryInFlight.has(notifyKey)) {
      continue;
    }
    const failedAt = state.xhsDiscoveryCooldown.get(item.roomId);
    if (failedAt && Date.now() - failedAt < FAILURE_COOLDOWN_MS) continue;

    state.xhsDiscoveryInFlight.add(notifyKey);
    try {
      console.log(
        `[XhsDiscovery] 命中监控主播 ${item.nickname || item.userId || item.redId}，` +
          `直播间 ${item.roomId}，上报到 ${targetEnvs.map((env) => env.name).join(', ')}`
      );

      const activeCount = await sendToEnvironments(
        targetEnvs,
        item.streamUrl,
        buildTitle(item, roomUrl),
        roomUrl,
        item.nickname || '',
        item.coverUrl || '',
        {
          hostUserId: item.userId || '',
          liveRoomId: item.roomId,
        }
      );

      // 仅在后端确实接受了录制请求（或已在录制）时标记；失败进入冷却，稍后重试。
      if (activeCount > 0) {
        state.xhsDiscoveryCooldown.delete(item.roomId);
        state.notifiedRooms.add(notifyKey);
        await persistNotifiedRooms(state.notifiedRooms);
      } else {
        state.xhsDiscoveryCooldown.set(item.roomId, Date.now());
      }
    } catch (err) {
      state.xhsDiscoveryCooldown.set(item.roomId, Date.now());
      console.warn('[XhsDiscovery] 上报失败:', err.message);
    } finally {
      state.xhsDiscoveryInFlight.delete(notifyKey);
    }
  }
}
