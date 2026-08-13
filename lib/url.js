// lib/url.js
// URL 校验和提取，合并三处重复的 isKuaishouLiveRoomUrl()

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

/**
 * 归一化直播间 URL：去掉 query、hash 和尾部斜杠，得到稳定的房间标识。
 * 快手直播间 tab.url 常带 ?liveStreamId=xxx 等动态参数，若直接用作 roomUrl
 * 会与后端 rooms.room_url（无 query）精确匹配失败，导致录制状态查询恒为 not found。
 */
export function normalizeRoomUrl(url) {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.href.replace(/\/$/, '');
  } catch (_) {
    return typeof url === 'string' ? url : '';
  }
}

export function getLiveRoomUrlFromRequest(details, tab) {
  return [details.documentUrl, tab?.url].find((url) =>
    isKuaishouLiveRoomUrl(url)
  );
}
