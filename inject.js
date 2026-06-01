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

  // 用于标识当前页面是快手直播间
  const isKuaishouLive =
    location.hostname === 'live.kuaishou.com' &&
    /^\/u\/[^/?#]+/.test(location.pathname);

  if (!isKuaishouLive) return;

  console.log(TAG, `弹幕拦截脚本已注入 (${VERSION})`);

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
  };

  // [DEBUG] 记录前 N 条已解码消息的结构
  const decodedDebugLog = [];
  const MAX_DECODED_DEBUG = 8;

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

    // 跳过心跳 ACK、enter room ACK、观众列表等控制/非弹幕消息
    if (payloadType === PT.HEARTBEAT_ACK || payloadType === PT.ENTER_ROOM_ACK) {
      return null;
    }
    // pt=340 是在线观众列表（包含用户名但无评论文本），跳过以避免误提取
    if (payloadType === 340) {
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

    // 其他未知类型：暂不处理（避免从非弹幕消息中误提取）
    return null;
  }

  /**
   * 解析 FeedPush payload
   * 已知结构: { f5: commentFeeds(repeated msg), f8: giftFeeds(repeated msg), ... }
   */
  function parsePbFeedPush(payload) {
    const events = [];

    // 优先从已知字段提取：f5 = 评论列表, f8 = 礼物列表
    const commentFeeds = getMessages(payload, 5);
    for (const msg of commentFeeds) {
      const comment = tryExtractComment(msg);
      if (comment) events.push(comment);
    }

    const giftFeeds = getMessages(payload, 8);
    for (const msg of giftFeeds) {
      const gift = tryExtractGift(msg);
      if (gift) events.push(gift);
    }

    // 如果已知字段没有产出结果，回退到扫描所有字段
    if (events.length === 0) {
      for (const fieldNum of Object.keys(payload)) {
        const msgs = getMessages(payload, fieldNum);
        if (msgs.length === 0) continue;
        for (const msg of msgs) {
          const comment = tryExtractComment(msg);
          if (comment) { events.push(comment); continue; }
          const gift = tryExtractGift(msg);
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
   * 尝试从嵌套消息中提取礼物事件
   * 礼物特征：包含礼物名称 + 数量(varint) + 用户名
   */
  function tryExtractGift(msg) {
    if (!msg) return null;

    const allStrings = [];
    const varints = [];
    const nestedMsgs = {};

    for (const fn of Object.keys(msg)) {
      const fnNum = parseInt(fn, 10);
      const arr = msg[fn];
      for (const entry of arr) {
        if (entry.wireType === 2 && entry.type === 'string') {
          allStrings.push({ fieldNum: fnNum, value: entry.value });
        } else if (entry.wireType === 0) {
          varints.push({ fieldNum: fnNum, value: entry.value });
        } else if (entry.wireType === 2 && entry.type === 'message') {
          nestedMsgs[fnNum] = entry.value;
        }
      }
    }

    // 从嵌套的用户子消息获取用户名
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
        const s3 = getString(nested, 3);
        if (s3) userNameSet.add(s3);
        break;
      }
    }

    // 查找礼物名称：非用户名、非 URL 的短字符串
    let giftName = '';
    for (const s of allStrings) {
      if (userNameSet.has(s.value)) continue;
      if (!isRealText(s.value)) continue;
      if (s.value.length < 50 && !giftName) {
        giftName = s.value;
      }
    }

    if (!giftName) return null;

    // 数量通常是一个小 varint (1-10000)
    let count = 1;
    for (const v of varints) {
      if (v.value >= 1 && v.value <= 10000) {
        count = v.value;
        break;
      }
    }

    return {
      type: 'gift',
      ts_ms: Date.now(),
      user: userName || '未知',
      userId: userId || '',
      giftName: giftName,
      giftId: '',
      count: count,
      raw: { source: 'protobuf' },
    };
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
    const ws = protocols !== undefined
      ? new OriginalWebSocket(url, protocols)
      : new OriginalWebSocket(url);

    // 只追踪快手相关的 WebSocket
    const isKsWs =
      typeof url === 'string' &&
      (url.includes('kuaishou') || url.includes('kwai') || url.includes('yximgs'));

    if (isKsWs) {
      trackedInstances.add(ws);
      console.log(TAG, '检测到快手 WebSocket 连接:', url.slice(0, 80));
      console.log(TAG, `  binaryType=${ws.binaryType}, readyState=${ws.readyState}`);
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

  // ========== 消息解析函数 ==========

  function parseJsonMessage(msg) {
    if (!msg || typeof msg !== 'object') return null;

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
  }, 15000);

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
