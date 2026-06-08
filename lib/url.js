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

export function getLiveRoomUrlFromRequest(details, tab) {
  return [details.documentUrl, tab?.url].find((url) =>
    isKuaishouLiveRoomUrl(url)
  );
}
