// lib/url.js
// URL 校验和提取，统一支持快手与小红书直播间 URL 识别与归一化

export function isKuaishouLiveRoomUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === 'live.kuaishou.com' &&
      /^\/u\/[^/?#]+/.test(parsed.pathname)
    );
  } catch (_) {
    return false;
  }
}

export function isXiaohongshuLiveRoomUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const isXhsHost =
      host === 'xiaohongshu.com' ||
      host.endsWith('.xiaohongshu.com') ||
      host === 'redelight.cn' ||
      host.endsWith('.redelight.cn');
    if (!isXhsHost) return false;

    const segments = parsed.pathname.split('/').filter(Boolean);
    const liveIdx = segments.findIndex((s) => s.toLowerCase() === 'livestream');
    if (liveIdx < 0) return false;

    const afterLive = segments.slice(liveIdx + 1).filter((seg) => !/^dynpath/i.test(seg));
    return afterLive.length > 0 && Boolean(afterLive[0]);
  } catch (_) {
    return false;
  }
}

export function isSupportedLiveRoomUrl(url) {
  return isKuaishouLiveRoomUrl(url) || isXiaohongshuLiveRoomUrl(url);
}

/**
 * 归一化直播间 URL：去掉 query、hash 和尾部斜杠，得到稳定的房间标识。
 * - 快手直播间：https://live.kuaishou.com/u/{principalId}
 * - 小红书直播间：剥离 dynpath 防封段与追踪参数，统一为 https://www.xiaohongshu.com/livestream/{roomId}
 *   与后端 server/lib/utils/room-url.js 严格对齐。
 */
export function normalizeRoomUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const isXhsHost =
      host === 'xiaohongshu.com' ||
      host.endsWith('.xiaohongshu.com') ||
      host === 'redelight.cn' ||
      host.endsWith('.redelight.cn');

    if (isXhsHost) {
      const segments = u.pathname.split('/').filter(Boolean);
      const liveIdx = segments.findIndex((s) => s.toLowerCase() === 'livestream');
      if (liveIdx >= 0) {
        const afterLive = segments.slice(liveIdx + 1).filter((seg) => !/^dynpath/i.test(seg));
        const roomIdCandidate = afterLive.find((seg) => /^\d{10,}$/.test(seg)) || afterLive[0];
        if (roomIdCandidate) {
          return `https://www.xiaohongshu.com/livestream/${roomIdCandidate}`;
        }
      }
    }

    u.search = '';
    u.hash = '';
    return u.href.replace(/\/$/, '');
  } catch (_) {
    return typeof url === 'string' ? url : '';
  }
}

/**
 * 从小红书直播间 URL 提取本场 room_id（仅 livestream 地址有值）。
 * 用于录制上报时附带 live_room_id，帮助后端归并到稳定的主播目标。
 */
export function getXiaohongshuLiveRoomId(url) {
  if (!isXiaohongshuLiveRoomUrl(url)) return '';
  const normalized = normalizeRoomUrl(url);
  const match = normalized.match(/\/livestream\/([^/?#]+)/);
  return match ? match[1] : '';
}

export function getLiveRoomUrlFromRequest(details, tab) {
  return [details.documentUrl, tab?.url].find((url) =>
    isSupportedLiveRoomUrl(url)
  );
}
