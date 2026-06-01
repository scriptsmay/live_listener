// danmaku-parser.js
// 弹幕消息标准化工具
// 将 inject.js 拦截到的原始事件标准化为后端可存储的格式

/**
 * 标准化弹幕事件，确保格式统一
 * @param {Object} rawEvent - inject.js 发送的原始事件
 * @param {number} sessionStartMs - 会话开始时间戳（用于计算相对时间）
 * @returns {Object} 标准化后的事件
 */
export function normalizeDanmakuEvent(rawEvent, sessionStartMs = 0) {
  if (!rawEvent || typeof rawEvent !== 'object') return null;

  const tsAbs = rawEvent.ts_ms || Date.now();
  const tsRelative = sessionStartMs > 0 ? Math.max(0, tsAbs - sessionStartMs) : tsAbs;

  const base = {
    ts_ms: tsRelative,
    ts_abs_ms: tsAbs,
    type: rawEvent.type || 'unknown',
  };

  switch (rawEvent.type) {
    case 'comment':
      return {
        ...base,
        user: String(rawEvent.user || '').slice(0, 64),
        userId: String(rawEvent.userId || ''),
        text: String(rawEvent.text || '').slice(0, 512),
      };
    case 'gift':
      return {
        ...base,
        user: String(rawEvent.user || '').slice(0, 64),
        userId: String(rawEvent.userId || ''),
        giftName: String(rawEvent.giftName || '').slice(0, 64),
        giftId: String(rawEvent.giftId || ''),
        count: Math.max(1, parseInt(rawEvent.count, 10) || 1),
      };
    case 'like':
      return {
        ...base,
        count: parseInt(rawEvent.count, 10) || 0,
      };
    default:
      return { ...base, raw: rawEvent };
  }
}

/**
 * 批量标准化事件
 * @param {Array} events - 原始事件数组
 * @param {number} sessionStartMs - 会话开始时间戳
 * @returns {Array} 标准化后的事件数组
 */
export function normalizeDanmakuBatch(events, sessionStartMs = 0) {
  if (!Array.isArray(events)) return [];
  const result = [];
  for (const event of events) {
    const normalized = normalizeDanmakuEvent(event, sessionStartMs);
    if (normalized) result.push(normalized);
  }
  return result;
}

/**
 * 过滤弹幕（排除主播自己的弹幕、屏蔽词等）
 * @param {Array} events - 标准化事件数组
 * @param {Object} options - 过滤选项
 * @returns {Array} 过滤后的事件数组
 */
export function filterDanmakuEvents(events, options = {}) {
  const {
    streamerName = '',      // 主播名称，过滤主播自己的弹幕
    blockWords = [],         // 屏蔽词列表
    includeGifts = true,     // 是否包含礼物
    includeLikes = false,    // 是否包含点赞
  } = options;

  return events.filter((event) => {
    if (!event) return false;

    // 过滤主播弹幕
    if (streamerName && event.user === streamerName) return false;

    // 屏蔽词过滤
    if (blockWords.length > 0 && event.type === 'comment' && event.text) {
      const text = event.text.toLowerCase();
      if (blockWords.some((word) => text.includes(word.toLowerCase()))) {
        return false;
      }
    }

    // 过滤礼物
    if (!includeGifts && event.type === 'gift') return false;

    // 过滤点赞
    if (!includeLikes && event.type === 'like') return false;

    return true;
  });
}
