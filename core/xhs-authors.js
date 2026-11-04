// core/xhs-authors.js
// 小红书监控主播条目的解析与匹配。
//
// 支持的行格式（每行一个）：
//   531916795                                小红书号（red_id）
//   5c2f2f8c000000000701d3dd                  用户 ID（host_user_id）
//   https://www.xiaohongshu.com/user/profile/{userId}
//   王者荣耀女子公开赛|531916795               昵称|小红书号（或昵称|用户ID）
//   王者荣耀女子公开赛                          纯昵称（仅按昵称匹配，改昵称后失效）
//
// 匹配优先级：用户 ID > 小红书号 > 昵称。用户 ID 才是稳定身份，
// 小红书号可能被修改，昵称可重复。

const USER_ID_RE = /^[0-9a-f]{24}$/i;
const NUMERIC_ID_RE = /^\d{6,20}$/;

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function extractUserIdFromUrl(text) {
  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase();
    const isXhsHost =
      host === 'xiaohongshu.com' ||
      host.endsWith('.xiaohongshu.com') ||
      host === 'redelight.cn' ||
      host.endsWith('.redelight.cn');
    if (!isXhsHost) return '';

    const queryUserId =
      url.searchParams.get('host_id') || url.searchParams.get('hostId');
    if (queryUserId) return queryUserId;

    const segments = url.pathname.split('/').filter(Boolean);
    const profileIdx = segments.findIndex((s) => s.toLowerCase() === 'profile');
    if (profileIdx >= 0 && segments[profileIdx + 1]) {
      return segments[profileIdx + 1];
    }
    return '';
  } catch (_) {
    return '';
  }
}

/**
 * 解析单行监控配置。
 * @param {string} raw
 * @returns {{name: string, userId: string, redId: string}|null}
 */
export function parseXhsAuthorEntry(raw) {
  let text = normalizeText(raw);
  if (!text) return null;

  let name = '';
  const pipeIdx = text.indexOf('|');
  if (pipeIdx > 0) {
    name = text.slice(0, pipeIdx).trim();
    text = text.slice(pipeIdx + 1).trim();
  }
  if (!text) return null;

  if (/^https?:\/\//i.test(text)) {
    const userId = extractUserIdFromUrl(text);
    return userId
      ? { name, userId, redId: '' }
      : { name: name || text, userId: '', redId: '' };
  }

  if (USER_ID_RE.test(text)) {
    return { name, userId: text.toLowerCase(), redId: '' };
  }
  if (NUMERIC_ID_RE.test(text)) {
    return { name, userId: '', redId: text };
  }

  return { name: name || text, userId: '', redId: '' };
}

/**
 * 把环境配置中的 xiaohongshuAuthors 展开成匹配索引。
 * @param {Array<{name: string, xiaohongshuAuthors?: string[]}>} environments
 * @returns {{entry: {name: string, userId: string, redId: string}, env: object}[]}
 */
export function buildXhsAuthorIndex(environments) {
  const index = [];
  for (const env of environments || []) {
    const entries = Array.isArray(env.xiaohongshuAuthors)
      ? env.xiaohongshuAuthors
      : [];
    for (const raw of entries) {
      const entry = parseXhsAuthorEntry(raw);
      if (entry) index.push({ entry, env });
    }
  }
  return index;
}

/**
 * 判断一条页面直播信息是否命中某个监控条目。
 * @param {{userId?: string, redId?: string, nickname?: string}} item
 * @param {{name: string, userId: string, redId: string}} entry
 * @returns {boolean}
 */
export function matchesXhsAuthor(item, entry) {
  if (!item || !entry) return false;
  const userId = normalizeText(item.userId).toLowerCase();
  const redId = normalizeText(item.redId);
  const nickname = normalizeText(item.nickname);
  const nicknameMatches = Boolean(
    entry.name && nickname && entry.name === nickname
  );

  // 配置了稳定 ID 时，页面只要给出了同维度 ID 就必须严格相等，
  // 不能仅凭昵称命中别的同名主播；页面对该维度完全没数据时才退回昵称。
  if (entry.userId) {
    if (userId) return entry.userId.toLowerCase() === userId;
    return nicknameMatches;
  }
  if (entry.redId) {
    if (redId) return entry.redId === redId;
    return nicknameMatches;
  }
  return nicknameMatches;
}

/**
 * 返回命中的环境列表（去重）。
 * @param {{userId?: string, redId?: string, nickname?: string}} item
 * @param {ReturnType<typeof buildXhsAuthorIndex>} index
 * @returns {object[]}
 */
export function findTargetEnvironments(item, index) {
  const matched = new Set();
  for (const { entry, env } of index) {
    if (matchesXhsAuthor(item, entry)) matched.add(env);
  }
  return [...matched];
}
