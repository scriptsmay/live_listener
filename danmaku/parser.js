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

  // 显式校验时间戳，避免 ts_ms=0 被 || 误判为 falsy
  let tsAbs;
  if (typeof rawEvent.ts_ms === 'number' && rawEvent.ts_ms > 0) {
    tsAbs = rawEvent.ts_ms;
  } else {
    tsAbs = Date.now();
  }
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

/**
 * UTF-8 Base64 解码（兼容浏览器 atob 与 Node Buffer）
 * @param {string} b64
 * @returns {string}
 */
export function decodeBase64Utf8(b64) {
  if (typeof b64 !== 'string' || !b64) return '';
  try {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(b64, 'base64').toString('utf-8');
    }
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
  } catch (_) {
    return '';
  }
}

/**
 * 解析小红书 RWP WebSocket 下行帧（t=4 SYNC 帧或 data.items 兼容帧）
 *
 * 外层格式：
 * { v: 1, t: 4, m: "...", b: { d: { a: 0, biz: "live", t: 1762246800123, b: [{ d: "<base64>", m: "..." }] } } }
 *
 * @param {string|Object} frameInput - WebSocket 原始文本或已解析 JSON 对象
 * @returns {Array<Object>} 提取出的原始弹幕事件数组
 */
export function parseXiaohongshuWsFrame(frameInput) {
  let outer = frameInput;
  if (typeof frameInput === 'string') {
    if (
      frameInput.length < 10 ||
      (!frameInput.includes('"b"') && !frameInput.includes('"items"'))
    ) {
      return [];
    }
    try {
      outer = JSON.parse(frameInput);
    } catch (_) {
      return [];
    }
  }

  if (!outer || typeof outer !== 'object') return [];

  const syncData = outer.b && outer.b.d;
  const items = Array.isArray(syncData?.b)
    ? syncData.b
    : Array.isArray(outer.data?.items)
      ? outer.data.items
      : null;

  if (!items || items.length === 0) return [];

  const frameTs = Number(syncData?.t) || 0;
  const events = [];

  for (const item of items) {
    const b64 = item && (typeof item.d === 'string' ? item.d : typeof item.b === 'string' ? item.b : '');
    if (!b64) continue;

    const decodedStr = decodeBase64Utf8(b64);
    if (!decodedStr) continue;

    let decoded;
    try {
      decoded = JSON.parse(decodedStr);
    } catch (_) {
      continue;
    }

    let cd = decoded?.customData ?? decoded?.data ?? decoded;
    if (typeof cd === 'string') {
      try {
        cd = JSON.parse(cd);
      } catch (_) {
        continue;
      }
    }
    if (!cd || typeof cd !== 'object') continue;

    const msgType = String(cd.type || '');
    const ts =
      Number(cd.current_time) ||
      Number(decoded?.ts) ||
      frameTs ||
      Date.now();
    const profile = cd.profile || cd.send_user_info || cd.user || {};
    const user = String(profile.nickname || profile.nick_name || profile.userName || '').trim();
    const userId = String(profile.user_id || profile.userId || '');

    if (msgType === 'text' || msgType === 'text_message') {
      const text = String(
        cd.desc ?? cd.content?.message ?? cd.content?.desc ?? cd.text ?? ''
      ).trim();
      if (!text) continue;
      events.push({
        type: 'comment',
        ts_ms: ts,
        user: user || '匿名',
        userId,
        text,
        raw: {
          source: 'xhs_rwp_ws',
          commentId: String(cd.commentId || decoded?.msgId || item.m || ''),
        },
      });
    } else if (msgType === 'gift_comment') {
      const giftInfo = cd.gift_info || {};
      const giftName = String(giftInfo.name || cd.giftName || cd.desc || '礼物').trim();
      const giftId = String(giftInfo.gift_id || giftInfo.id || cd.giftId || '');
      const count = Math.max(1, parseInt(giftInfo.count ?? cd.giftCount ?? 1, 10) || 1);
      events.push({
        type: 'gift',
        ts_ms: ts,
        user: user || '匿名',
        userId,
        giftName,
        giftId,
        count,
        raw: {
          source: 'xhs_rwp_ws',
          commentId: String(cd.commentId || decoded?.msgId || item.m || ''),
        },
      });
    } else if (msgType === 'praise' || msgType === 'light' || msgType === 'combo_praise') {
      const count = Math.max(1, parseInt(cd.count ?? 1, 10) || 1);
      events.push({
        type: 'like',
        ts_ms: ts,
        user,
        userId,
        count,
        raw: {
          source: 'xhs_rwp_ws',
        },
      });
    }
  }

  return events;
}
