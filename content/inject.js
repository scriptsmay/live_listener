// inject.js — 注入到快手直播间 MAIN world
// 作用：通过原型级 hook 拦截 WebSocket 消息，捕获弹幕（protobuf 二进制 + JSON 双模式）
// 通过 window.postMessage 将解析后的弹幕事件传递给 content.js (ISOLATED world)

(function () {
  'use strict';

  // 防止重复注入
  if (window.__KS_DANMAKU_INJECTED__) return;
  window.__KS_DANMAKU_INJECTED__ = true;

  const TAG = '[KS-Danmaku]';
  const VERSION = 'v3 - protobuf decode';

  // ========== 调试开关 ==========
  const DEBUG = {
    gift: true,           // 礼物采集详细调试
    allPayloadTypes: true, // 打印所有 payloadType 分布
    unknownTypeScan: true, // 对未知 payloadType 尝试提取礼物
    giftStructureSample: 5, // 采样打印前 N 条疑似礼物消息的完整结构
  };

  // 用于标识当前页面是快手直播间或小红书域名
  const isKuaishouLive =
    location.hostname === 'live.kuaishou.com' &&
    /^\/u\/[^/?#]+/.test(location.pathname);

  const hostLower = location.hostname.toLowerCase();
  const isXiaohongshuHost =
    hostLower === 'xiaohongshu.com' ||
    hostLower.endsWith('.xiaohongshu.com') ||
    hostLower === 'redelight.cn' ||
    hostLower.endsWith('.redelight.cn');

  function isXiaohongshuLivePage() {
    if (!isXiaohongshuHost) return false;
    const segments = location.pathname.split('/').filter(Boolean);
    const liveIdx = segments.findIndex((s) => s.toLowerCase() === 'livestream');
    if (liveIdx < 0) return false;
    const afterLive = segments.slice(liveIdx + 1).filter((seg) => !/^dynpath/i.test(seg));
    return afterLive.length > 0 && Boolean(afterLive[0]);
  }

  if (!isKuaishouLive && !isXiaohongshuHost) return;

  console.log(TAG, `弹幕拦截脚本已注入 (${VERSION}, host=${location.hostname})`);

  // ========== 小红书弹幕去重（RWP WebSocket + DOM MutationObserver 双通道）==========
  // 同一评论可能被两个通道各采一次（WS 先到、DOM 虚拟列表稍后渲染），因此需要
  // 跨通道窗口；而 DOM 虚拟列表会滚动回收节点、整段重渲染历史评论，重渲染的
  // 时间间隔可达数分钟，必须用更长的窗口单独抑制，否则会重复落库。
  const XHS_CROSS_CHANNEL_WINDOW_MS = 5000;
  const XHS_DOM_RENDER_WINDOW_MS = 5 * 60 * 1000;
  const xhsRecentComments = new Map(); // `${user}|${text}` -> ts（跨通道）
  const xhsDomRenderedComments = new Map(); // `${user}|${text}` -> ts（DOM 重渲染抑制）
  const xhsDomMessageIds = new Map(); // 稳定消息 id -> ts
  const reportedFlvUrls = new Set();

  /**
   * 删除 Map 头部过期条目。
   * Map 保持插入顺序且时间戳单调递增，遇到首个未过期条目即可停止。
   * @param {Map<string, number>} map
   * @param {number} now
   * @param {number} ttl
   */
  function pruneExpiredEntries(map, now, ttl) {
    for (const [k, ts] of map) {
      if (now - ts <= ttl) break;
      map.delete(k);
    }
  }

  function hasRecentEntry(map, key, now, ttl) {
    const prev = map.get(key);
    return prev !== undefined && now - prev <= ttl;
  }

  /**
   * 写入/刷新条目并保持插入顺序与时间顺序一致。
   * Map 对已存在的 key 赋值不会改变其插入位置，会让 pruneExpiredEntries
   * 的「遇到首个未过期条目即停止」失效，因此先删除再写入。
   */
  function touchEntry(map, key, now) {
    map.delete(key);
    map.set(key, now);
  }

  /**
   * 是否应发送该条评论。
   * @param {string} user
   * @param {string} text - 已剥离昵称前缀的正文
   * @param {{channel?: 'ws'|'dom', messageId?: string}} [options]
   * @returns {boolean}
   */
  function shouldEmitXhsComment(user, text, options = {}) {
    const now = Date.now();
    const key = `${user || '未知'}|${text}`;
    const channel = options.channel || 'ws';
    const messageId = options.messageId || '';

    pruneExpiredEntries(xhsRecentComments, now, XHS_CROSS_CHANNEL_WINDOW_MS);

    if (channel === 'dom') {
      pruneExpiredEntries(xhsDomRenderedComments, now, XHS_DOM_RENDER_WINDOW_MS);
      if (hasRecentEntry(xhsDomRenderedComments, key, now, XHS_DOM_RENDER_WINDOW_MS)) return false;

      if (messageId) {
        pruneExpiredEntries(xhsDomMessageIds, now, XHS_DOM_RENDER_WINDOW_MS);
        if (hasRecentEntry(xhsDomMessageIds, messageId, now, XHS_DOM_RENDER_WINDOW_MS)) return false;
        touchEntry(xhsDomMessageIds, messageId, now);
      }
      // 即使随后被跨通道窗口拦下，也要登记，避免重渲染时再次尝试发送
      touchEntry(xhsDomRenderedComments, key, now);
    }

    if (hasRecentEntry(xhsRecentComments, key, now, XHS_CROSS_CHANNEL_WINDOW_MS)) return false;
    touchEntry(xhsRecentComments, key, now);
    return true;
  }

  function decodeBase64Utf8(b64) {
    if (!b64 || typeof b64 !== 'string') return null;
    try {
      // 兼容 URL-safe Base64（- _ 替换 + /）
      const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
      const binary = atob(normalized);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new TextDecoder('utf-8').decode(bytes);
    } catch (_) {
      return null;
    }
  }

  function parseXiaohongshuRwpMessage(msg) {
    if (!msg || typeof msg !== 'object') return null;

    // RWP 协议：t=4 为 SYNC 服务端推送帧，数据包位于 b.d.b[].d (Base64 UTF-8 JSON)
    // t 在个别帧里可能是字符串 "4"
    let rawItems = null;
    if (Number(msg.t) === 4 && msg.b && msg.b.d && Array.isArray(msg.b.d.b)) {
      rawItems = msg.b.d.b;
    } else if (msg.customData && typeof msg.customData === 'object') {
      rawItems = [{ decodedObj: msg }];
    } else {
      return null;
    }

    const events = [];
    for (const item of rawItems) {
      if (!item || typeof item !== 'object') continue;
      let decodedObj = item.decodedObj || null;
      if (!decodedObj && item.d && typeof item.d === 'object') {
        // 少数帧的 d 字段直接是对象而非 Base64 字符串
        decodedObj = item.d;
      }
      if (!decodedObj && typeof item.d === 'string') {
        const jsonStr = decodeBase64Utf8(item.d);
        if (!jsonStr) continue;
        try {
          decodedObj = JSON.parse(jsonStr);
        } catch (_) {
          continue;
        }
      }
      if (!decodedObj || typeof decodedObj !== 'object') continue;

      const cd =
        decodedObj.customData && typeof decodedObj.customData === 'object'
          ? decodedObj.customData
          : decodedObj;
      const cdType = cd.type || '';
      const tsMs =
        typeof cd.current_time === 'number' && cd.current_time > 0
          ? cd.current_time
          : Date.now();

      if (cdType === 'text' || cdType === 'text_message') {
        const contentField = cd.content;
        const text = (
          typeof cd.desc === 'string'
            ? cd.desc
            : typeof contentField === 'string'
              ? contentField
              : contentField && typeof contentField === 'object'
                ? (contentField.message ?? contentField.desc ?? '')
                : (cd.text ?? '')
        )
          .toString()
          .trim();
        if (!text) continue;
        const profile = cd.profile || cd.send_user_info || cd.user || {};
        const user =
          profile.nickname || profile.nick_name || profile.userName || profile.user_name || profile.name || '未知';
        const userId = String(profile.user_id || profile.userId || profile.uid || profile.id || '');
        if (!shouldEmitXhsComment(user, text, { channel: 'ws' })) continue;
        stats.commentCount++;
        events.push({
          type: 'comment',
          ts_ms: tsMs,
          user,
          userId,
          text,
          raw: { source: 'xhs_rwp_ws', type: cdType },
        });
      } else if (cdType === 'gift_comment') {
        const profile = cd.profile || cd.send_user_info || cd.user || {};
        const giftInfo = cd.gift_info || cd.giftInfo || {};
        const user =
          profile.nickname || profile.nick_name || profile.userName || profile.user_name || profile.name || '未知';
        const userId = String(profile.user_id || profile.userId || profile.uid || profile.id || '');
        const giftName = giftInfo.name || giftInfo.giftName || cd.desc || '未知礼物';
        const giftId = String(giftInfo.gift_id || giftInfo.giftId || giftInfo.id || '');
        const count = Number(giftInfo.count || cd.count || 1) || 1;
        stats.giftCount++;
        events.push({
          type: 'gift',
          ts_ms: tsMs,
          user,
          userId,
          giftName,
          giftId,
          count,
          raw: { source: 'xhs_rwp_ws', type: cdType },
        });
      } else if (cdType === 'praise' || cdType === 'light' || cdType === 'combo_praise') {
        const count = Number(cd.count || 1) || 1;
        const profile = cd.profile || cd.send_user_info || cd.user || {};
        stats.likeCount += count;
        events.push({
          type: 'like',
          ts_ms: tsMs,
          user: profile.nickname || profile.nick_name || profile.userName || '',
          userId: String(profile.user_id || profile.userId || profile.uid || profile.id || ''),
          count,
          raw: { source: 'xhs_rwp_ws', type: cdType },
        });
      }
    }

    return events.length > 0 ? events : null;
  }

  function maybeReportXhsFlvUrl(url) {
    if (!isXiaohongshuHost || typeof url !== 'string') return;
    if (!url.includes('.flv')) return;
    const cleanUrl = url.startsWith('//') ? `${location.protocol}${url}` : url;
    if (!cleanUrl.startsWith('http')) return;
    if (reportedFlvUrls.has(cleanUrl)) return;
    reportedFlvUrls.add(cleanUrl);
    window.postMessage(
      {
        source: 'ks-danmaku-inject',
        type: 'flv_stream_url',
        url: cleanUrl,
        timestamp: Date.now(),
      },
      '*'
    );
  }

  // 保存原始引用
  const OriginalWebSocket = window.WebSocket;
  const origAddEventListener = EventTarget.prototype.addEventListener;

  // 追踪所有通过我们 patch 创建的 WebSocket 实例
  const trackedInstances = new WeakSet();

  // 记录拦截统计
  let stats = {
    totalMessages: 0,
    stringMessages: 0,
    binaryMessages: 0,
    decodedMessages: 0,
    feedPushCount: 0,
    commentCount: 0,
    giftCount: 0,
    likeCount: 0,
    handlerRegistrations: 0,
    errorCount: 0,
    skippedSmall: 0,
    // 礼物调试相关
    giftScanAttempts: 0,
    giftScanSuccesses: 0,
    giftScanNoName: 0,
    giftScanNoUser: 0,
    // 连接调试相关
    wsConstructorCalls: 0,
    ksWsConnections: 0,
    fetchCalls: 0,
    xhrCalls: 0,
  };

  // [DEBUG] 记录前 N 条已解码消息的结构
  const decodedDebugLog = [];
  const MAX_DECODED_DEBUG = 8;

  // [DEBUG] payloadType 分布统计
  const payloadTypeStats = {};

  // [DEBUG] 礼物提取失败样例（用于分析结构）
  const giftFailSamples = [];
  const MAX_GIFT_FAIL_SAMPLES = 10;

  // [DEBUG] 礼物提取成功样例
  const giftSuccessSamples = [];
  const MAX_GIFT_SUCCESS_SAMPLES = 10;

  // ========== Protobuf 线格式解码器 ==========

  const textDecoder = new TextDecoder('utf-8', { fatal: true });

  /**
   * 读取 protobuf varint（支持 32 位精度，足够消息类型和长度）
   */
  function readVarint(buf, offset) {
    let result = 0, shift = 0;
    while (offset < buf.length) {
      const byte = buf[offset++];
      result |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) return { value: result >>> 0, offset };
      if (shift >= 35) return { value: result >>> 0, offset, overflow: true };
    }
    return { value: result >>> 0, offset, truncated: true };
  }

  /**
   * 通用 protobuf 线格式解码器
   * 返回 { fieldNumber: [{ wireType, value }], ... } 结构
   * wireType: 0=varint, 2=length-delimited
   * value: number (varint) | string (utf-8) | object (nested) | Uint8Array (raw bytes)
   */
  function decodeProto(buf, depth) {
    if (depth === undefined) depth = 0;
    if (depth > 8 || !buf || buf.length < 2) return null;

    const fields = {};
    let offset = 0;

    while (offset < buf.length) {
      // 读取字段标签
      const tagRes = readVarint(buf, offset);
      if (tagRes.overflow || tagRes.truncated) break;
      offset = tagRes.offset;

      const fieldNum = tagRes.value >>> 3;
      const wireType = tagRes.value & 0x7;
      if (fieldNum < 1 || fieldNum > 536870911) break; // 非法字段号

      if (wireType === 0) {
        // Varint
        const valRes = readVarint(buf, offset);
        if (valRes.truncated) break;
        offset = valRes.offset;
        addField(fields, fieldNum, { wireType: 0, value: valRes.value });

      } else if (wireType === 2) {
        // Length-delimited (string / bytes / nested message)
        const lenRes = readVarint(buf, offset);
        if (lenRes.truncated) break;
        offset = lenRes.offset;
        const len = lenRes.value;

        if (len < 0 || offset + len > buf.length) break;
        const data = buf.subarray(offset, offset + len);
        offset += len;

        // 尝试 UTF-8 字符串
        let str = null;
        if (len > 0 && len < 10000) {
          try {
            str = textDecoder.decode(data);
            // 控制字符（除常见空白外）表示这不是纯文本
            if (/[\x00-\x08\x0e-\x1f]/.test(str)) str = null;
          } catch (_) { /* 不是有效 UTF-8 */ }
        }

        if (str !== null) {
          addField(fields, fieldNum, { wireType: 2, type: 'string', value: str });
        } else if (len >= 2) {
          // 尝试递归解码为嵌套消息
          const nested = decodeProto(data, depth + 1);
          if (nested && Object.keys(nested).length > 0) {
            addField(fields, fieldNum, { wireType: 2, type: 'message', value: nested });
          } else {
            addField(fields, fieldNum, { wireType: 2, type: 'bytes', value: data, length: len });
          }
        } else {
          addField(fields, fieldNum, { wireType: 2, type: 'bytes', value: data, length: len });
        }

      } else if (wireType === 5) {
        // 32-bit fixed
        if (offset + 4 > buf.length) break;
        offset += 4;
        addField(fields, fieldNum, { wireType: 5, value: 0 });

      } else if (wireType === 1) {
        // 64-bit fixed
        if (offset + 8 > buf.length) break;
        offset += 8;
        addField(fields, fieldNum, { wireType: 1, value: 0 });

      } else {
        break; // 未知线格式，停止解码
      }
    }

    return Object.keys(fields).length > 0 ? fields : null;
  }

  function addField(fields, num, entry) {
    if (!fields[num]) fields[num] = [];
    fields[num].push(entry);
  }

  /**
   * 从解码后的 protobuf 字段中取第一个 varint 值
   */
  function getVarint(fields, fieldNum) {
    const arr = fields[fieldNum];
    if (!arr) return undefined;
    for (const entry of arr) {
      if (entry.wireType === 0) return entry.value;
    }
    return undefined;
  }

  /**
   * 从解码后的 protobuf 字段中取第一个嵌套消息
   */
  function getMessage(fields, fieldNum) {
    const arr = fields[fieldNum];
    if (!arr) return undefined;
    for (const entry of arr) {
      if (entry.wireType === 2 && entry.type === 'message') return entry.value;
    }
    return undefined;
  }

  /**
   * 从解码后的 protobuf 字段中取第一个字符串
   */
  function getString(fields, fieldNum) {
    const arr = fields[fieldNum];
    if (!arr) return undefined;
    for (const entry of arr) {
      if (entry.wireType === 2 && entry.type === 'string') return entry.value;
    }
    return undefined;
  }

  /**
   * 从解码后的 protobuf 字段中取所有重复的嵌套消息（repeated message）
   */
  function getMessages(fields, fieldNum) {
    const arr = fields[fieldNum];
    if (!arr) return [];
    return arr.filter(e => e.wireType === 2 && e.type === 'message').map(e => e.value);
  }

  /**
   * 判断字符串是否为"真实文本"（过滤掉 base64 编码、URL、短乱码、内部标识符）
   */
  function isRealText(s) {
    if (!s || s.length < 1) return false;
    // 排除 URL
    if (s.startsWith('http://') || s.startsWith('https://')) return false;
    // 排除 base64 风格短字符串（以 == 或 = 结尾，且长度 < 20，无中文字符）
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length < 20 && !/[\u4e00-\u9fff]/.test(s)) return false;
    // 排除纯 ASCII 控制字符或不可打印字符
    if (/^[\x00-\x1f\x7f]+$/.test(s)) return false;
    // 排除太短且不含中日韩字符的无意义字符串
    if (s.length <= 2 && !/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(s)) return false;
    // 排除数字 ID 串（多组数字用 - 连接，如 "3059002722-9635429-11500-122"）
    if (/^\d{3,}(-\d{2,}){2,}$/.test(s)) return false;
    // 排除 camelCase/snake_case 内部标识符（如 "highFrequency_multiLike_v2"）
    if (/^[a-z]+[A-Z][a-zA-Z]*(_[a-zA-Z0-9]+)+$/.test(s)) return false;
    // 排除纯数字+连字符+下划线组合
    if (/^[\d\-_]+$/.test(s) && s.length > 5) return false;
    return true;
  }

  // ========== Protobuf 弹幕提取 ==========

  // 已知消息 PayloadType（来自逆向文档）
  const PT = {
    HEARTBEAT_ACK: 101,
    ENTER_ROOM_ACK: 300,
    FEED_PUSH: 310,
    COMMENT_RICH_TEXT: 829,
  };

  /**
   * 从解码后的 protobuf 外层消息中提取弹幕事件
   * 外层结构: { 1: payloadType(varint), 2: seqId(varint), 3: payload(bytes/msg) }
   */
  function extractPbEvents(decoded) {
    if (!decoded) return null;

    const payloadType = getVarint(decoded, 1);
    if (payloadType === undefined) return null;

    // [DEBUG] 统计 payloadType 分布
    if (DEBUG.allPayloadTypes) {
      payloadTypeStats[payloadType] = (payloadTypeStats[payloadType] || 0) + 1;
    }

    // 跳过心跳 ACK、enter room ACK、观众列表等控制/非弹幕消息
    if (payloadType === PT.HEARTBEAT_ACK || payloadType === PT.ENTER_ROOM_ACK) {
      return null;
    }
    // pt=340 是在线观众列表（包含用户名但无评论文本），跳过以避免误提取
    if (payloadType === 340) {
      return null;
    }
    // pt=510 是点赞引导/高频点赞提示，不是礼物也不是评论
    if (payloadType === 510) {
      return null;
    }

    // 取 payload（field 3，可能是嵌套消息或原始字节）
    const payload = getMessage(decoded, 3);
    if (!payload) return null;

    // 尝试作为 FeedPush 解析 (PayloadType 310)
    if (payloadType === PT.FEED_PUSH) {
      return parsePbFeedPush(payload);
    }

    // 尝试作为 RichText 评论 (PayloadType 829)
    if (payloadType === PT.COMMENT_RICH_TEXT) {
      return parsePbRichTextComment(payload);
    }

    // 其他未知类型：尝试扫描礼物和评论
    if (DEBUG.unknownTypeScan) {
      const events = tryExtractFromUnknownPayload(payload, payloadType);
      if (events && events.length > 0) return events;
    }

    return null;
  }

  /**
   * 对未知 PayloadType 的消息尝试提取礼物和评论
   * 用于发现新的礼物消息类型
   */
  function tryExtractFromUnknownPayload(payload, payloadType) {
    const events = [];

    // 先尝试直接提取（payload 本身可能是礼物/评论消息）
    const directGift = tryExtractGift(payload, `unknown_pt_${payloadType}_direct`);
    if (directGift) {
      events.push(directGift);
    }
    const directComment = tryExtractComment(payload);
    if (directComment) {
      directComment.raw.payloadType = `unknown_${payloadType}`;
      events.push(directComment);
    }

    // 扫描所有字段中的嵌套消息
    for (const fieldNum of Object.keys(payload)) {
      const fnNum = parseInt(fieldNum, 10);
      const msgs = getMessages(payload, fnNum);
      if (msgs.length === 0) continue;

      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i];
        const ctx = `unknown_pt_${payloadType}_f${fnNum}_${i}`;

        const gift = tryExtractGift(msg, ctx);
        if (gift) {
          events.push(gift);
          continue;
        }
        const comment = tryExtractComment(msg);
        if (comment) {
          comment.raw.payloadType = `unknown_${payloadType}_f${fnNum}`;
          events.push(comment);
        }
      }
    }

    return events.length > 0 ? events : null;
  }

  /**
   * 解析 FeedPush payload
   * 已知结构: { f5: commentFeeds(repeated msg), f8: giftFeeds(repeated msg), ... }
   */
  function parsePbFeedPush(payload) {
    const events = [];

    // 优先从已知字段提取：f5 = 评论列表, f8 = 礼物列表
    const commentFeeds = getMessages(payload, 5);
    for (let i = 0; i < commentFeeds.length; i++) {
      const comment = tryExtractComment(commentFeeds[i]);
      if (comment) {
        comment.raw.fieldNum = 5;
        comment.raw.index = i;
        events.push(comment);
      }
    }

    const giftFeeds = getMessages(payload, 8);
    for (let i = 0; i < giftFeeds.length; i++) {
      const gift = tryExtractGift(giftFeeds[i], `feed_push_f8_${i}`);
      if (gift) events.push(gift);
    }

    // 如果已知字段没有产出结果，回退到扫描其他字段
    // 跳过已知非礼物字段: f5=评论, f9=观众进入
    if (events.length === 0) {
      const skipFields = ['5', '9'];
      for (const fieldNum of Object.keys(payload)) {
        if (skipFields.includes(fieldNum)) continue;
        const msgs = getMessages(payload, fieldNum);
        if (msgs.length === 0) continue;
        for (let i = 0; i < msgs.length; i++) {
          const msg = msgs[i];
          const ctx = `feed_push_fallback_f${fieldNum}_${i}`;
          const comment = tryExtractComment(msg);
          if (comment) {
            comment.raw.fieldNum = parseInt(fieldNum, 10);
            comment.raw.source = 'protobuf_fallback';
            events.push(comment);
            continue;
          }
          const gift = tryExtractGift(msg, ctx);
          if (gift) events.push(gift);
        }
      }
    }

    return events.length > 0 ? events : null;
  }

  /**
   * 尝试从嵌套消息中提取单条评论
   * 已知结构: { f2: {f1=userId, f2=userName, f3=avatar}, ..., 评论文本字段 }
   * 评论文本是消息中最长的"真实文本"字符串（排除 URL、base64、用户名）
   */
  function tryExtractComment(msg) {
    if (!msg) return null;

    // 收集所有字符串字段、嵌套消息和 varint
    const allStrings = [];   // { fieldNum, value }
    const nestedMsgs = {};
    let firstVarint = undefined;

    for (const fn of Object.keys(msg)) {
      const fnNum = parseInt(fn, 10);
      const arr = msg[fn];
      for (const entry of arr) {
        if (entry.wireType === 2 && entry.type === 'string') {
          allStrings.push({ fieldNum: fnNum, value: entry.value });
        } else if (entry.wireType === 2 && entry.type === 'message') {
          nestedMsgs[fnNum] = entry.value;
        } else if (entry.wireType === 0 && firstVarint === undefined) {
          firstVarint = entry.value;
        }
      }
    }

    // 从嵌套的用户子消息中获取用户名和 userId
    let userName = '';
    let userId = '';
    const userNameSet = new Set();
    for (const fn of Object.keys(nestedMsgs)) {
      const nested = nestedMsgs[fn];
      const s1 = getString(nested, 1);
      const s2 = getString(nested, 2);
      if (s1 || s2) {
        userId = s1 || '';
        userName = s2 || s1 || '';
        userNameSet.add(userId);
        userNameSet.add(userName);
        // 也把头像 URL 排除
        const s3 = getString(nested, 3);
        if (s3) userNameSet.add(s3);
        break;
      }
    }

    // 在所有字符串中查找评论文本：最长的"真实文本"且不是用户名/URL
    let text = '';
    for (const s of allStrings) {
      if (userNameSet.has(s.value)) continue;
      if (!isRealText(s.value)) continue;
      if (s.value.length > text.length) text = s.value;
    }

    if (!text) return null;

    // firstVarint 可能是 showType，2 表示被过滤的评论
    if (firstVarint === 2) return null;

    return {
      type: 'comment',
      ts_ms: Date.now(),
      user: userName || '未知',
      userId: userId || '',
      text: text,
      raw: { source: 'protobuf', payloadType: 'feed_push' },
    };
  }

  /**
   * 递归提取嵌套消息中的所有字符串和 varint
   * 用于在 gift feed 的深层嵌套结构中查找礼物名/数量
   */
  function deepScanFields(fields, depth, maxDepth) {
    if (depth > maxDepth || !fields) return { strings: [], varints: [] };
    const strings = [];
    const varints = [];
    for (const fn of Object.keys(fields)) {
      const fnNum = parseInt(fn, 10);
      const arr = fields[fn];
      for (const entry of arr) {
        if (entry.wireType === 2 && entry.type === 'string') {
          strings.push({ fieldNum: fnNum, value: entry.value, depth: depth });
        } else if (entry.wireType === 0) {
          varints.push({ fieldNum: fnNum, value: entry.value, depth: depth });
        } else if (entry.wireType === 2 && entry.type === 'message') {
          const sub = deepScanFields(entry.value, depth + 1, maxDepth);
          for (const s of sub.strings) strings.push(s);
          for (const v of sub.varints) varints.push(v);
        }
      }
    }
    return { strings, varints };
  }

  /**
   * 尝试从嵌套消息中提取礼物事件
   * 快手礼物 feed 结构: f2=用户, f4=礼物ID(base64), f5=礼物详情(嵌套)
   * 礼物名和数量可能在 f5 的深层嵌套中
   */
  function tryExtractGift(msg, contextLabel) {
    if (!msg) return null;

    stats.giftScanAttempts++;

    const topStrings = [];
    const topVarints = [];
    const nestedMsgs = {};

    for (const fn of Object.keys(msg)) {
      const fnNum = parseInt(fn, 10);
      const arr = msg[fn];
      for (const entry of arr) {
        if (entry.wireType === 2 && entry.type === 'string') {
          topStrings.push({ fieldNum: fnNum, value: entry.value });
        } else if (entry.wireType === 0) {
          topVarints.push({ fieldNum: fnNum, value: entry.value });
        } else if (entry.wireType === 2 && entry.type === 'message') {
          nestedMsgs[fnNum] = entry.value;
        }
      }
    }

    // ========== 快速排除：检测明确的非礼物事件 ==========
    // 收集所有层级中的类型标识字符串
    const allLabels = new Set();
    
    // 收集顶层字符串
    for (const s of topStrings) {
      allLabels.add(s.value);
    }
    
    // 收集所有嵌套消息中的 f3 字段（类型标识字段）
    for (const fn of Object.keys(nestedMsgs)) {
      const msg = nestedMsgs[fn];
      for (const innerFn of Object.keys(msg)) {
        const arr = msg[innerFn];
        for (const entry of arr) {
          if (entry.wireType === 2 && entry.type === 'message') {
            const label = getString(entry.value, 3);
            if (label) allLabels.add(label);
          }
        }
      }
    }
    
    // 如果包含这些类型标识，说明不是礼物
    const nonGiftLabels = [
      'audienceIntimacyState',  // 观众亲密状态
      'fansGroup',               // 粉丝团
      'fansClub',                // 粉丝俱乐部
      'wealthGrade',             // 财富等级
      'sign-in',                 // 签到
      'signin',                  // 签到
      'highFrequency',           // 高频点赞
      'multiLike',               // 批量点赞
    ];
    for (const label of nonGiftLabels) {
      if (allLabels.has(label)) {
        return null;
      }
    }

    // 从嵌套的用户子消息获取用户名
    let userName = '';
    let userId = '';
    const userNameSet = new Set();
    let userFieldNum = null;
    for (const fn of Object.keys(nestedMsgs)) {
      const nested = nestedMsgs[fn];
      const s1 = getString(nested, 1);
      const s2 = getString(nested, 2);
      if (s1 || s2) {
        userId = s1 || '';
        userName = s2 || s1 || '';
        userNameSet.add(userId);
        userNameSet.add(userName);
        const s3 = getString(nested, 3);
        if (s3) userNameSet.add(s3);
        userFieldNum = parseInt(fn, 10);
        break;
      }
    }

    if (!userName && DEBUG.gift) {
      stats.giftScanNoUser++;
    }

    // 深扫：从所有嵌套消息中提取字符串和 varint（最多 4 层）
    const deepScan = deepScanFields(msg, 0, 4);

    // ========== 查找礼物名 ==========
    // 优先在深层嵌套中找"真实文本"字符串
    let giftName = '';
    let giftFieldNum = null;
    let giftFieldDepth = 0;

    // 判断字符串是否可能是礼物名
    function isLikelyGiftName(s) {
      if (!s || s.length < 2) return false;
      if (!isRealText(s)) return false;
      // 排除 URL (http, https, 自定义协议如 kwai://)
      if (/^[a-z]+:\/\//i.test(s)) return false;
      if (s.startsWith('http://') || s.startsWith('https://')) return false;
      // 排除 JSON
      if (s.startsWith('{') || s.startsWith('[')) return false;
      // 排除图片路径
      if (/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(s)) return false;
      if (s.includes('/') && (s.includes('.png') || s.includes('.jpg'))) return false;
      // 排除域名 (包含 .com / .cn / .wsukwai 等)
      if (/\.(com|cn|net|org|wsukwai|kuaishou)/i.test(s)) return false;
      if (s.includes('wsukwai.com') || s.includes('kuaishou.com')) return false;
      // 排除已知标签关键字
      const excludePatterns = [
        'wealthGrade', 'fansGroup', '粉丝团', 'level_label', 'fans_label',
        'label_v2', 'sign-in', 'signin', '签到', 'dialog',
        'audienceIntimacy', 'intimacy_', 'highFrequency', 'multiLike',
        '去点赞', '人在点赞', '秒后关闭',
      ];
      const lower = s.toLowerCase();
      for (const p of excludePatterns) {
        if (lower.includes(p.toLowerCase())) return false;
      }
      // 排除纯数字
      if (/^\d+$/.test(s)) return false;
      // 排除纯数字+短横线组合（ID 类）
      if (/^\d[\d-]{4,}$/.test(s)) return false;
      // 排除 camelCase / snake_case 内部标识符（全英文且含大小写或下划线）
      if (/^[a-z][a-zA-Z]+(_[a-zA-Z0-9]+)+$/.test(s)) return false;
      // 排除太短的（1-2个字符且没有中文的）
      if (s.length <= 2 && !/[\u4e00-\u9fff]/.test(s)) return false;
      return true;
    }

    // 先扫描深层嵌套中的真实文本（排除用户名）
    const deepRealStrings = deepScan.strings.filter(s => {
      if (userNameSet.has(s.value)) return false;
      return isLikelyGiftName(s.value);
    });

    if (deepRealStrings.length > 0) {
      // 按长度排序，选最长的（通常礼物名比标签描述长）
      deepRealStrings.sort((a, b) => b.value.length - a.value.length);
      giftName = deepRealStrings[0].value;
      giftFieldNum = deepRealStrings[0].fieldNum;
      giftFieldDepth = deepRealStrings[0].depth;
    }

    // ========== 提取礼物 ID（f4 字段通常是 base64 礼物标识）==========
    let giftId = '';
    for (const s of topStrings) {
      if (s.fieldNum === 4) {
        giftId = s.value;
        break;
      }
    }
    if (!giftId && topStrings.length > 0) {
      const firstNonUser = topStrings.find(s => !userNameSet.has(s.value));
      if (firstNonUser) giftId = firstNonUser.value;
    }

    // ========== 查找礼物数量 ==========
    // 优先从顶层 varint 中找
    let count = 1;
    let countFieldNum = null;
    let countDepth = 0;

    for (const v of topVarints) {
      if (v.value >= 1 && v.value <= 10000) {
        count = v.value;
        countFieldNum = v.fieldNum;
        break;
      }
    }

    // 如果顶层没找到，从深层嵌套的 varint 中找
    if (!countFieldNum) {
      // 排除值为 0 或过大的（通常是 ID），找 1-10000 范围的
      const candidateCounts = deepScan.varints.filter(v =>
        v.value >= 1 && v.value <= 10000
      );
      // 优先选择深度较深的（通常嵌套层级更深的是具体计数）
      candidateCounts.sort((a, b) => b.depth - a.depth || a.value - b.value);
      if (candidateCounts.length > 0) {
        count = candidateCounts[0].value;
        countFieldNum = candidateCounts[0].fieldNum;
        countDepth = candidateCounts[0].depth;
      }
    }

    // 如果还是没找到 giftName，使用 giftId 作为 fallback
    if (!giftName && giftId) {
      giftName = `礼物#${giftId}`;
      giftFieldNum = 4;
    }

    if (!giftName) {
      if (DEBUG.gift && giftFailSamples.length < MAX_GIFT_FAIL_SAMPLES) {
        giftFailSamples.push({
          reason: 'no_gift_name',
          context: contextLabel || '',
          userField: userFieldNum,
          userName: userName,
          topStrings: topStrings.map(s => ({ f: s.fieldNum, v: s.value.slice(0, 40) })),
          topVarints: topVarints.map(v => ({ f: v.fieldNum, v: v.value })),
          deepStrings: deepScan.strings.slice(0, 10).map(s => ({ f: s.fieldNum, d: s.depth, v: s.value.slice(0, 40) })),
          deepVarints: deepScan.varints.slice(0, 10).map(v => ({ f: v.fieldNum, d: v.depth, v: v.value })),
          nestedCount: Object.keys(nestedMsgs).length,
          structure: summarizeDecoded(msg, 0),
        });
      }
      stats.giftScanNoName++;
      return null;
    }

    const result = {
      type: 'gift',
      ts_ms: Date.now(),
      user: userName || '未知',
      userId: userId || '',
      giftName: giftName,
      giftId: giftId,
      count: count,
      raw: {
        source: 'protobuf',
        context: contextLabel || '',
        giftFieldNum: giftFieldNum,
        giftFieldDepth: giftFieldDepth,
        userFieldNum: userFieldNum,
        countFieldNum: countFieldNum,
        countDepth: countDepth,
      },
    };

    stats.giftScanSuccesses++;
    if (DEBUG.gift && giftSuccessSamples.length < MAX_GIFT_SUCCESS_SAMPLES) {
      giftSuccessSamples.push({
        context: contextLabel || '',
        giftName: giftName,
        giftField: giftFieldNum,
        giftDepth: giftFieldDepth,
        giftId: giftId,
        user: userName,
        userField: userFieldNum,
        count: count,
        countField: countFieldNum,
        countDepth: countDepth,
        allDeepStrings: deepScan.strings.slice(0, 15).map(s => ({
          f: s.fieldNum, d: s.depth, v: s.value.slice(0, 50),
          isLikely: isLikelyGiftName(s.value),
        })),
        structure: summarizeDecoded(msg, 0),
      });
    }

    return result;
  }

  /**
   * 解析富文本评论 (PayloadType 829)
   */
  function parsePbRichTextComment(payload) {
    const events = [];
    const comment = tryExtractComment(payload);
    if (comment) {
      comment.raw.payloadType = 'rich_text';
      events.push(comment);
    }
    return events.length > 0 ? events : null;
  }

  /**
   * 通用提取：对未知 PayloadType 的消息，尝试从嵌套结构中查找评论
   */
  function tryExtractCommentsFromPayload(payload, payloadType) {
    const events = [];

    // 递归搜索嵌套消息中的评论数据
    function searchForComments(fields, depth) {
      if (!fields || depth > 3) return;
      for (const fn of Object.keys(fields)) {
        const msgs = getMessages(fields, parseInt(fn, 10));
        for (const msg of msgs) {
          const comment = tryExtractComment(msg);
          if (comment) {
            comment.raw.payloadType = payloadType;
            events.push(comment);
          } else {
            // 再深入一层（可能是 commentFeeds 列表容器）
            searchForComments(msg, depth + 1);
          }
        }
      }
    }

    searchForComments(payload, 0);
    return events.length > 0 ? events : null;
  }

  /**
   * 为调试生成精简的解码结构描述
   */
  function summarizeDecoded(fields, depth) {
    if (!fields || depth > 3) return '{}';
    depth = depth || 0;
    const parts = [];
    for (const fn of Object.keys(fields).sort((a, b) => a - b)) {
      const entries = fields[fn];
      for (const e of entries) {
        if (e.wireType === 0) {
          parts.push(`f${fn}=v${e.value}`);
        } else if (e.type === 'string') {
          const preview = e.value.length > 30 ? e.value.slice(0, 30) + '…' : e.value;
          parts.push(`f${fn}=s"${preview}"`);
        } else if (e.type === 'message') {
          parts.push(`f${fn}=${summarizeDecoded(e.value, depth + 1)}`);
        } else {
          parts.push(`f${fn}=b[${e.length}]`);
        }
      }
    }
    return `{${parts.join(', ')}}`;
  }

  /**
   * 处理已解码的 protobuf 二进制消息
   */
  function processBinaryMessage(bytes) {
    stats.binaryMessages++;

    // 小红书 RWP 帧在部分环境以二进制帧下发（内容是 UTF-8 JSON 而非 protobuf），
    // 先尝试按 JSON 解析，失败后再走快手 protobuf 解码。
    if (isXiaohongshuHost) {
      try {
        const text = new TextDecoder('utf-8').decode(bytes);
        if (text.length >= 10 && (text.includes('"b"') || text.includes('"items"'))) {
          const msg = JSON.parse(text);
          const xhsEvents = parseXiaohongshuRwpMessage(msg);
          if (xhsEvents && xhsEvents.length > 0) {
            stats.feedPushCount++;
            postDanmakuEvents(xhsEvents);
            return;
          }
        }
      } catch (_) {
        // 非 JSON 二进制帧，继续按 protobuf 处理
      }
    }

    let decoded;
    try {
      decoded = decodeProto(bytes);
    } catch (e) {
      stats.errorCount++;
      return;
    }

    if (!decoded) {
      stats.skippedSmall++;
      return;
    }

    stats.decodedMessages++;

    // [DEBUG] 记录前几条解码结果
    if (decodedDebugLog.length < MAX_DECODED_DEBUG) {
      const payloadType = getVarint(decoded, 1);
      decodedDebugLog.push({
        n: stats.binaryMessages,
        size: bytes.length,
        payloadType: payloadType !== undefined ? payloadType : '?',
        summary: summarizeDecoded(decoded, 0),
      });
    }

    // 提取弹幕事件
    const events = extractPbEvents(decoded);
    if (events && events.length > 0) {
      stats.feedPushCount++;
      for (const e of events) {
        if (e.type === 'comment') stats.commentCount++;
        else if (e.type === 'gift') stats.giftCount++;
        else if (e.type === 'like') stats.likeCount++;
      }
      postDanmakuEvents(events);
    }
  }

  /**
   * 处理 WebSocket 消息事件
   * 在原始 handler 被调用之前执行
   */
  function processMessageEvent(ws, event) {
    const data = event.data;
    stats.totalMessages++;

    // ===== 二进制消息：使用 protobuf 解码 =====
    if (data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(data);
      // 跳过太小的消息（< 10 字节通常是心跳 ACK）
      if (bytes.length < 10) {
        stats.binaryMessages++;
        stats.skippedSmall++;
        return;
      }
      processBinaryMessage(bytes);
      return;
    }

    if (data instanceof Blob) {
      stats.binaryMessages++;
      // Blob 需要异步读取
      if (data.size < 10) {
        stats.skippedSmall++;
        return;
      }
      data.arrayBuffer().then(buf => {
        processBinaryMessage(new Uint8Array(buf));
      });
      return;
    }

    // ===== 字符串消息：尝试 JSON 解析（降级兼容）=====
    if (typeof data !== 'string') return;

    stats.stringMessages++;

    try {
      const msg = JSON.parse(data);
      const events = parseJsonMessage(msg);
      if (events && events.length > 0) {
        stats.feedPushCount++;
        postDanmakuEvents(events);
      }
    } catch (_) {
      // 非 JSON 字符串，忽略
    }
  }

  // ========== 原型级 Hook ==========

  // Hook 1: EventTarget.prototype.addEventListener
  // 这是最底层的 hook，能捕获所有 addEventListener 调用
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    // 只处理 WebSocket 实例的 message 事件
    if (this instanceof OriginalWebSocket && type === 'message' && typeof listener === 'function') {
      stats.handlerRegistrations++;
      console.log(TAG, `[Hook] addEventListener('message') 被注册 (实例 #${stats.handlerRegistrations})`,
        this.url ? this.url.slice(0, 80) : '(no url)');

      const self = this;
      const wrappedListener = function (event) {
        processMessageEvent(self, event);
        listener.call(this, event);
      };
      return origAddEventListener.call(this, type, wrappedListener, options);
    }
    return origAddEventListener.call(this, type, listener, options);
  };

  // Hook 2: WebSocket.prototype 的 onmessage setter
  // 捕获所有 ws.onmessage = handler 赋值
  const origOnMessageDesc = Object.getOwnPropertyDescriptor(
    OriginalWebSocket.prototype, 'onmessage'
  );

  if (origOnMessageDesc && origOnMessageDesc.set) {
    Object.defineProperty(OriginalWebSocket.prototype, 'onmessage', {
      get: origOnMessageDesc.get,
      set(handler) {
        stats.handlerRegistrations++;
        console.log(TAG, `[Hook] onmessage setter 被调用 (实例 #${stats.handlerRegistrations})`,
          this.url ? this.url.slice(0, 80) : '(no url)');

        const self = this;
        const wrappedHandler = function (event) {
          processMessageEvent(self, event);
          if (typeof handler === 'function') {
            handler.call(this, event);
          }
        };
        origOnMessageDesc.set.call(this, wrappedHandler);
      },
      configurable: true,
      enumerable: origOnMessageDesc.enumerable,
    });
    console.log(TAG, 'WebSocket.prototype.onmessage setter 已 hook');
  } else {
    console.warn(TAG, '无法获取 WebSocket.prototype.onmessage 描述符，降级为构造函数 patch');
  }

  // ========== 构造函数 Patch（用于追踪实例和调试）==========

  function PatchedWebSocket(url, protocols) {
    stats.wsConstructorCalls++;

    const ws = protocols !== undefined
      ? new OriginalWebSocket(url, protocols)
      : new OriginalWebSocket(url);

    // 判断是否快手或小红书相关 WebSocket
    const isTargetWs =
      typeof url === 'string' &&
      (url.includes('kuaishou') ||
        url.includes('kwai') ||
        url.includes('yximgs') ||
        url.includes('xiaohongshu') ||
        url.includes('apppush-rws') ||
        url.includes('redelight') ||
        url.includes('live'));

    const urlPreview = typeof url === 'string' ? url.slice(0, 120) : String(url);

    if (isTargetWs) {
      stats.ksWsConnections++;
      trackedInstances.add(ws);
      console.log(TAG, `[WS-Constructor] 目标 WebSocket #${stats.ksWsConnections}: ${urlPreview}`);
      console.log(TAG, `  binaryType=${ws.binaryType}, readyState=${ws.readyState}, protocols=${ws.protocol || '(none)'}`);
    } else {
      console.log(TAG, `[WS-Constructor] 其他 WebSocket #${stats.wsConstructorCalls}: ${urlPreview}`);
    }

    return ws;
  }

  // 保留静态属性
  PatchedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  PatchedWebSocket.OPEN = OriginalWebSocket.OPEN;
  PatchedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
  PatchedWebSocket.CLOSED = OriginalWebSocket.CLOSED;

  // 替换全局 WebSocket
  window.WebSocket = PatchedWebSocket;
  console.log(TAG, 'WebSocket 构造函数已替换，原型级 hook 已就绪');

  // ========== Fetch / XHR 拦截（排查是否改用 HTTP 方式传弹幕）==========

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    stats.fetchCalls++;
    const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    if (url) {
      maybeReportXhsFlvUrl(url);
    }
    // 只打印疑似弹幕相关的请求
    if (url && (url.includes('danmu') || url.includes('danmaku') || url.includes('feed') ||
                url.includes('comment') || url.includes('live') || url.includes('gift') ||
                url.includes('kuaishou') || url.includes('kwai') || url.includes('xiaohongshu'))) {
      console.log(TAG, `[Fetch] #${stats.fetchCalls}: ${url.slice(0, 120)}`, init ? init.method || 'GET' : 'GET');
    }
    return originalFetch.apply(this, arguments);
  };

  const originalXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    stats.xhrCalls++;
    if (url) {
      maybeReportXhsFlvUrl(String(url));
    }
    if (url && (url.includes('danmu') || url.includes('danmaku') || url.includes('feed') ||
                url.includes('comment') || url.includes('live') || url.includes('gift') ||
                url.includes('kuaishou') || url.includes('kwai') || url.includes('xiaohongshu'))) {
      console.log(TAG, `[XHR] #${stats.xhrCalls}: ${method} ${String(url).slice(0, 120)}`);
    }
    return originalXHROpen.apply(this, arguments);
  };

  // ========== SSE (EventSource) 拦截 ==========
  if (window.EventSource) {
    const OriginalEventSource = window.EventSource;
    let sseCount = 0;

    function PatchedEventSource(url, configuration) {
      sseCount++;
      console.log(TAG, `[SSE] EventSource #${sseCount}: ${url.slice(0, 120)}`);
      const es = new OriginalEventSource(url, configuration);

      // 拦截 onmessage
      const origOnMsgDesc = Object.getOwnPropertyDescriptor(OriginalEventSource.prototype, 'onmessage');
      if (origOnMsgDesc && origOnMsgDesc.get) {
        // 尝试读取原型上的 onmessage
      }

      // 拦截 addEventListener
      const origAddListener = es.addEventListener;
      es.addEventListener = function (type, listener, options) {
        console.log(TAG, `[SSE] addEventListener('${type}') on #${sseCount}`);
        const wrapped = function (event) {
          console.log(TAG, `[SSE] 收到事件 type=${event.type}, data=`,
            event.data ? (typeof event.data === 'string' ? event.data.slice(0, 200) : event.data) : '(no data)');
          listener.call(this, event);
        };
        return origAddListener.call(this, type, wrapped, options);
      };

      return es;
    }

    // 拷贝静态属性
    PatchedEventSource.CONNECTING = OriginalEventSource.CONNECTING;
    PatchedEventSource.OPEN = OriginalEventSource.OPEN;
    PatchedEventSource.CLOSED = OriginalEventSource.CLOSED;

    window.EventSource = PatchedEventSource;
    console.log(TAG, 'EventSource (SSE) 构造函数已替换');
  } else {
    console.log(TAG, '当前浏览器不支持 EventSource');
  }

  // ========== 注入时机检测 ==========
  console.log(TAG, `注入时机: readyState=${document.readyState}, URL=${location.href}`);
  console.log(TAG, `当前时间: ${new Date().toISOString()}`);
  if (performance && performance.timing) {
    const t = performance.timing;
    if (t.navigationStart) {
      console.log(TAG, `距 navigationStart: ${performance.now().toFixed(0)}ms`);
    }
  }

  // ========== 消息解析函数 ==========

  function parseJsonMessage(msg) {
    if (!msg || typeof msg !== 'object') return null;

    if (isXiaohongshuHost) {
      const xhsEvents = parseXiaohongshuRwpMessage(msg);
      if (xhsEvents && xhsEvents.length > 0) {
        return xhsEvents;
      }
    }

    const type = msg.type || '';

    if (type === 'SC_FEED_PUSH') {
      return parseFeedPush(msg.payload);
    }

    if (type === 'SC_COMMENT_ZONE_RICH_TEXT') {
      return parseCommentZoneRichText(msg.payload);
    }

    // 心跳和 ACK 消息不需要处理
    if (type.startsWith('CS_') || type.startsWith('SC_HEARTBEAT') ||
        type.startsWith('SC_PING') || type.startsWith('SC_ECHO')) {
      return null;
    }

    return null;
  }

  function parseFeedPush(payload) {
    if (!payload) return null;

    const events = [];

    const commentFeeds = payload.commentFeeds || [];
    for (const comment of commentFeeds) {
      const event = extractCommentEvent(comment);
      if (event) events.push(event);
    }

    const giftFeeds = payload.giftFeeds || [];
    for (const gift of giftFeeds) {
      const event = extractGiftEvent(gift);
      if (event) events.push(event);
    }

    const likeFeeds = payload.likeFeeds || [];
    if (likeFeeds.length > 0) {
      events.push({
        type: 'like',
        ts_ms: Date.now(),
        count: payload.displayLikeCount || likeFeeds.length,
        raw: { likeCount: likeFeeds.length },
      });
    }

    stats.commentCount += commentFeeds.length;
    stats.giftCount += giftFeeds.length;
    stats.likeCount += likeFeeds.length;

    return events.length > 0 ? events : null;
  }

  function parseCommentZoneRichText(payload) {
    if (!payload) return null;
    const events = [];
    try {
      const text = payload.content || payload.text || '';
      const user = payload.user || {};
      if (text) {
        events.push({
          type: 'comment',
          ts_ms: Date.now(),
          user: user.userName || user.nickname || '未知',
          userId: user.principalId || user.uid || '',
          text: text,
          raw: payload,
        });
      }
    } catch (_) {}
    return events.length > 0 ? events : null;
  }

  function extractCommentEvent(comment) {
    try {
      if (comment.showType === 2) return null;
      const user = comment.user || {};
      const text = comment.content || '';
      if (!text) return null;
      return {
        type: 'comment',
        ts_ms: Date.now(),
        user: user.userName || user.nickname || '未知',
        userId: user.principalId || user.uid || '',
        text: text,
        raw: {
          showType: comment.showType,
          sendTime: comment.sendTime,
          mergeKey: comment.mergeKey || '',
        },
      };
    } catch (err) {
      stats.errorCount++;
      return null;
    }
  }

  function extractGiftEvent(gift) {
    try {
      const user = gift.user || {};
      return {
        type: 'gift',
        ts_ms: Date.now(),
        user: user.userName || user.nickname || '未知',
        userId: user.principalId || user.uid || '',
        giftName: gift.giftName || '未知礼物',
        giftId: gift.giftId || '',
        count: gift.batchSize || gift.comboCount || 1,
        raw: {
          mergeKey: gift.mergeKey || '',
          comboCount: gift.comboCount,
        },
      };
    } catch (err) {
      stats.errorCount++;
      return null;
    }
  }

  function postDanmakuEvents(events) {
    if (!events || events.length === 0) return;
    window.postMessage(
      {
        source: 'ks-danmaku-inject',
        type: 'danmaku_events',
        events: events,
        timestamp: Date.now(),
      },
      '*'
    );
  }

  // ========== 定时统计输出 ==========

  setInterval(() => {
    console.log(TAG,
      `统计: 总消息=${stats.totalMessages} (字符串=${stats.stringMessages}, 二进制=${stats.binaryMessages}, ` +
      `已解码=${stats.decodedMessages}, 跳过小=${stats.skippedSmall}), ` +
      `handler注册=${stats.handlerRegistrations}, FEED_PUSH=${stats.feedPushCount}, ` +
      `弹幕=${stats.commentCount}, 礼物=${stats.giftCount}, 点赞=${stats.likeCount}, 错误=${stats.errorCount}`
    );
    // 输出解码后的消息结构日志（调试用）
    if (decodedDebugLog.length > 0) {
      console.log(TAG, '已解码消息结构:');
      for (const d of decodedDebugLog) {
        console.log(TAG, `  #${d.n} size=${d.size} pt=${d.payloadType} → ${d.summary}`);
      }
    }

    // [DEBUG] 连接统计
    console.log(TAG,
      `连接统计: WS构造调用=${stats.wsConstructorCalls}, 快手WS=${stats.ksWsConnections}, ` +
      `fetch调用=${stats.fetchCalls}, XHR调用=${stats.xhrCalls}`
    );

    // [DEBUG] payloadType 分布
    if (DEBUG.allPayloadTypes) {
      const pts = Object.entries(payloadTypeStats)
        .sort((a, b) => b[1] - a[1])
        .map(([pt, count]) => `pt${pt}=${count}`)
        .join(', ');
      console.log(TAG, `PayloadType 分布: ${pts || '(无)'}`);
    }

    // [DEBUG] 礼物采集调试信息
    if (DEBUG.gift) {
      console.log(TAG,
        `礼物调试: 扫描尝试=${stats.giftScanAttempts}, 成功=${stats.giftScanSuccesses}, ` +
        `无礼物名=${stats.giftScanNoName}, 无用户=${stats.giftScanNoUser}`
      );
      if (giftSuccessSamples.length > 0) {
        console.log(TAG, `礼物成功样例 (${giftSuccessSamples.length}):`);
        for (let i = 0; i < giftSuccessSamples.length; i++) {
          const s = giftSuccessSamples[i];
          const parts = [`  [${i}] ctx=${s.context}`];
          parts.push(`礼物="${s.giftName}"(f${s.giftField}${s.giftDepth ? ` d${s.giftDepth}` : ''})`);
          if (s.giftId) parts.push(`礼物ID="${s.giftId}"`);
          parts.push(`用户="${s.user}"(f${s.userField})`);
          parts.push(`数量=${s.count}(f${s.countField}${s.countDepth ? ` d${s.countDepth}` : ''})`);
          console.log(TAG, parts.join(', '));
          if (s.allDeepStrings && s.allDeepStrings.length > 0) {
            console.log(TAG, `    所有深层字符串候选:`);
            for (const str of s.allDeepStrings) {
              const mark = str.isLikely ? '✅' : '❌';
              console.log(TAG, `      ${mark} f${str.f} d${str.d}: "${str.v}"`);
            }
          }
          console.log(TAG, `    结构: ${s.structure}`);
        }
      }
      if (giftFailSamples.length > 0) {
        console.log(TAG, `礼物失败样例 (${giftFailSamples.length}):`);
        for (let i = 0; i < giftFailSamples.length; i++) {
          const s = giftFailSamples[i];
          console.log(TAG,
            `  [${i}] ctx=${s.context}, reason=${s.reason}, ` +
            `用户="${s.userName}"(f${s.userField}), ` +
            `顶层字符串=${s.topStrings ? s.topStrings.length : 0}, ` +
            `顶层varint=${s.topVarints ? s.topVarints.length : 0}, ` +
            `深层字符串=${s.deepStrings ? s.deepStrings.length : 0}, ` +
            `深层varint=${s.deepVarints ? s.deepVarints.length : 0}, ` +
            `嵌套=${s.nestedCount}`
          );
          if (s.topStrings && s.topStrings.length > 0) {
            console.log(TAG, `    顶层字符串:`);
            for (const str of s.topStrings.slice(0, 10)) {
              console.log(TAG, `      f${str.f}: "${str.v}"`);
            }
          }
          if (s.deepStrings && s.deepStrings.length > 0) {
            console.log(TAG, `    深层字符串(前10):`);
            for (const str of s.deepStrings.slice(0, 10)) {
              console.log(TAG, `      f${str.f} d${str.d}: "${str.v}"`);
            }
          }
          if (s.deepVarints && s.deepVarints.length > 0) {
            console.log(TAG, `    深层Varint(前10): ${s.deepVarints.map(v => `f${v.f}d${v.d}=${v.v}`).join(', ')}`);
          }
          console.log(TAG, `    结构: ${s.structure}`);
        }
      }
    }
  }, 15000);

  // ========== 小红书 DOM MutationObserver 兜底通道 ==========
  // 当浏览器未登录小红书或 RWP WebSocket 被降级时，通过观察评论区虚拟列表提取弹幕，
  // 并通过 shouldEmitXhsComment 与 WebSocket 通道共享去重窗口。
  //
  // 注意：评论区虚拟列表里混有三类节点，必须区别对待，否则会污染弹幕分析：
  // 1. 普通评论 —— `.msg-content` 的 textContent 同时包含昵称节点，需要剥离昵称前缀；
  // 2. 系统提示 —— 「xxx 来了」「xxx 关注了主播」等，不是用户弹幕，直接丢弃；
  // 3. 点赞提示 —— 「xxx 为主播点赞了」，归类为 like 而不是 comment。
  const XHS_SYSTEM_ACTION_PATTERNS = [
    { type: 'like', re: /^(为主播点赞了|给主播点了赞|点亮了)$/ },
    { type: 'enter', re: /^(来了|来啦|进入直播间|进入了直播间|加入了直播间|进入直播)$/ },
    { type: 'follow', re: /^(关注了主播|关注了直播间|关注了TA)$/ },
    { type: 'share', re: /^(分享了直播间|分享了直播|分享了TA的直播)$/ },
  ];

  function classifyXhsSystemAction(text) {
    for (const { type, re } of XHS_SYSTEM_ACTION_PATTERNS) {
      if (re.test(text)) return type;
    }
    return null;
  }

  /** 从元素自身属性里读取第一个非空值 */
  function readXhsAttr(el, names) {
    if (!el || typeof el.getAttribute !== 'function') return '';
    for (const name of names) {
      const value = el.getAttribute(name);
      if (value) return value.trim();
    }
    return '';
  }

  /**
   * 尝试从 DOM 提取用户 ID。
   * 优先读 data-* 属性，其次从用户主页链接 `/user/profile/{userId}` 反解。
   * 小红书评论区 DOM 并不保证携带 uid，取不到时返回空串。
   */
  function extractXhsDomUserId(item, nickEl) {
    const uidAttrs = ['data-user-id', 'data-userid', 'data-uid'];
    const direct = readXhsAttr(item, uidAttrs) || readXhsAttr(nickEl, uidAttrs);
    if (direct) return direct;

    const anchors = [];
    if (item && typeof item.querySelectorAll === 'function') {
      anchors.push(...item.querySelectorAll('a[href*="/user/profile/"]'));
    }
    if (nickEl && typeof nickEl.closest === 'function') {
      const anchor = nickEl.closest('a[href*="/user/profile/"]');
      if (anchor) anchors.push(anchor);
    }
    for (const anchor of anchors) {
      const href = anchor.getAttribute('href') || '';
      const match = href.match(/\/user\/profile\/([^/?#]+)/);
      if (match) return match[1];
    }
    return '';
  }

  /** 虚拟列表节点上的稳定消息 ID（存在时用于跨重渲染去重） */
  function extractXhsDomMessageId(item) {
    return readXhsAttr(item, [
      'custom-key',
      'data-key',
      'data-id',
      'data-msg-id',
      'data-message-id',
      'data-comment-id',
    ]);
  }

  /**
   * 读取元素富文本，表情图片用 alt 还原（如 `[害羞R]`）。
   * 直接取 textContent 会丢失 `<img class="emoji-img" alt="...">` 的表情内容。
   */
  function extractXhsRichText(el) {
    if (!el) return '';
    let out = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) {
        out += node.nodeValue;
      } else if (node.nodeType === 1) {
        if (node.tagName === 'IMG') {
          out += node.getAttribute('alt') || '';
        } else {
          out += extractXhsRichText(node);
        }
      }
    }
    return out;
  }

  /**
   * 提取评论正文并剥离昵称前缀。
   *
   * 小红书真实 DOM：`.msg-content` 内含 `<span class="nickname">` 与
   * `<span class="content">`，正文在 `.content`，但 `.msg-content` 的
   * textContent 是「昵称 + 正文」拼接。优先直接读 `.content`；若结构变化
   * 找不到 `.content`，则回退到从 `.msg-content` 中剥离昵称前缀。
   */
  function extractXhsDomCommentText(contentEl, rawNick) {
    const contentBody = contentEl.querySelector('.content');
    if (contentBody) {
      return extractXhsRichText(contentBody).trim();
    }

    let text = extractXhsRichText(contentEl).trim();
    const nick = String(rawNick || '')
      .replace(/[：:]\s*$/, '')
      .trim();
    if (nick && text.startsWith(nick)) {
      text = text.slice(nick.length).replace(/^[\s：:]+/, '').trim();
    }
    return text;
  }

  /**
   * 扫描评论区虚拟列表。
   *
   * @param {Element} root
   * @param {{seedOnly?: boolean}} [options] seedOnly 只登记已挂载的历史评论而不发送
   *   （首次扫描时使用，避免把开扫前的历史弹幕当成新弹幕落库）
   */
  function scanXiaohongshuDomComments(root, options = {}) {
    if (!isXiaohongshuLivePage()) return;
    if (!root || typeof root.querySelectorAll !== 'function') return;

    const items = root.classList && root.classList.contains('virtual-list-item')
      ? [root]
      : root.querySelectorAll('.virtual-list-item');
    if (!items || items.length === 0) return;

    const events = [];
    for (const item of items) {
      if (!item || typeof item.querySelector !== 'function') continue;
      const contentEl = item.querySelector('.msg-content');
      if (!contentEl) continue;

      const nickEl = item.querySelector('.nickname');
      const rawNick = nickEl ? (nickEl.textContent || '').trim() : '';
      let user = rawNick.replace(/[：:]\s*$/, '').trim() || '未知';
      let text = extractXhsDomCommentText(contentEl, rawNick);
      if (!text) continue;

      // 个别系统提示节点没有独立的 .nickname，正文形如「昵称 来了」，
      // 这里把前缀昵称拆出来，使下面的系统提示判定仍能命中
      if (!rawNick) {
        const systemSplit = text.match(
          /^(.+?)\s+(来了|来啦|为主播点赞了|关注了主播|分享了直播间|进入直播间|进入了直播间)$/
        );
        if (systemSplit) {
          user = systemSplit[1].trim();
          text = systemSplit[2];
        }
      }

      const messageId = extractXhsDomMessageId(item);
      const commentKey = messageId ? `id:${messageId}` : `${user}|${text}`;
      if (item.__ksLastCommentKey === commentKey) continue;
      item.__ksLastCommentKey = commentKey;

      // 非 role-user 的 wrapper 是进房/点赞/关注等系统提示节点，不是用户弹幕
      const wrapperEl = item.querySelector('.msg-wrapper');
      const wrapperClass = wrapperEl ? String(wrapperEl.className || '') : '';
      if (wrapperClass && !wrapperClass.includes('role-user')) continue;

      const action = classifyXhsSystemAction(text);
      const dedupeKey = action === 'like' ? `like:${text}` : text;

      if (options.seedOnly) {
        // 只登记为已见，避免扩展重载后把当前可见的历史评论当成新弹幕
        const now = Date.now();
        if (messageId) touchEntry(xhsDomMessageIds, messageId, now);
        touchEntry(xhsDomRenderedComments, `${user}|${dedupeKey}`, now);
        continue;
      }

      // 进房 / 关注 / 分享属于系统提示，不是用户弹幕
      if (action === 'enter' || action === 'follow' || action === 'share') continue;

      const userId = extractXhsDomUserId(item, nickEl);

      if (action === 'like') {
        if (!shouldEmitXhsComment(user, dedupeKey, { channel: 'dom', messageId })) continue;
        stats.likeCount++;
        events.push({
          type: 'like',
          ts_ms: Date.now(),
          user,
          userId,
          count: 1,
          raw: { source: 'xhs_dom_observer' },
        });
        continue;
      }

      if (!shouldEmitXhsComment(user, text, { channel: 'dom', messageId })) continue;

      stats.commentCount++;
      events.push({
        type: 'comment',
        ts_ms: Date.now(),
        user,
        userId,
        text,
        raw: { source: 'xhs_dom_observer' },
      });
    }

    if (events.length > 0) {
      stats.feedPushCount++;
      postDanmakuEvents(events);
    }
  }

  function setupXiaohongshuDomObserver() {
    if (!isXiaohongshuHost || typeof MutationObserver === 'undefined') return;

    const startObserve = () => {
      const target = document.body || document.documentElement;
      if (!target) {
        setTimeout(startObserve, 200);
        return;
      }

      // 首次扫描只登记当前已挂载的历史评论，不回放（它们早于本次采集开始）
      scanXiaohongshuDomComments(target, { seedOnly: true });

      const observer = new MutationObserver((mutations) => {
        if (!isXiaohongshuLivePage()) return;
        for (const mutation of mutations) {
          if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
            for (const node of mutation.addedNodes) {
              if (node && node.nodeType === 1) {
                scanXiaohongshuDomComments(node);
              }
            }
          } else if (mutation.type === 'characterData' && mutation.target && mutation.target.parentElement) {
            const item = mutation.target.parentElement.closest
              ? mutation.target.parentElement.closest('.virtual-list-item')
              : null;
            if (item) {
              scanXiaohongshuDomComments(item);
            }
          }
        }
      });

      observer.observe(target, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      console.log(TAG, '小红书评论区 DOM MutationObserver 兜底已就绪');
    };

    if (document.body) {
      startObserve();
    } else {
      window.addEventListener('DOMContentLoaded', startObserve, { once: true });
    }
  }

  if (isXiaohongshuHost) {
    setupXiaohongshuDomObserver();
  }

  // 通知 content.js 注入成功
  window.postMessage(
    {
      source: 'ks-danmaku-inject',
      type: 'danmaku_ready',
      timestamp: Date.now(),
    },
    '*'
  );
})();
