// lib/health.js
// 后端环境连通性探测（Options 只读展示用）
//
// 打 GET {baseUrl}/api/health：该端点在服务端鉴权白名单内（无需登录），
// 返回 { ok, db, redis, version }，HTTP 200 表示服务与依赖全通、503 表示
// 部分故障。比 /api/notify/status 更轻，也不会因缺少 url 参数返回 400。
//
// 这里直接用 fetchJson 而不走后台消息：/api/health 免鉴权，且环境地址已在
// manifest 的 host_permissions 中声明，页面上下文可以直接请求。

import { fetchJson } from './http.js';

export const HEALTH_API_PATH = '/api/health';
// 连通性探测允许比画质探测更短的超时：设置页打开时要尽快给出结果
const HEALTH_TIMEOUT_MS = 5000;

/**
 * 探测单个环境的连通性。
 * @param {{baseUrl?: string}} env
 * @returns {Promise<{state: 'connected'|'degraded'|'unreachable',
 *                    label: string, detail: string, version?: string,
 *                    db?: boolean, redis?: boolean}>}
 */
export async function checkEnvironmentHealth(env) {
  const baseUrl = typeof env?.baseUrl === 'string'
    ? env.baseUrl.replace(/\/$/, '')
    : '';
  if (!baseUrl) {
    return {
      state: 'unreachable',
      label: '地址为空',
      detail: '未配置服务地址',
    };
  }

  try {
    const result = await fetchJson(
      `${baseUrl}${HEALTH_API_PATH}`,
      {},
      HEALTH_TIMEOUT_MS
    );
    const data = result.data || {};
    const version = typeof data.version === 'string' ? data.version : '';

    // 服务能响应但依赖不全（db/redis 掉线）：仍算连通，但标为"服务异常"
    if (result.ok && data.ok === true) {
      return {
        state: 'connected',
        label: version ? `已连接 · v${version}` : '已连接',
        detail: `HTTP 200 · 数据库 ${data.db ? '正常' : '异常'} · Redis ${
          data.redis ? '正常' : '异常'
        }`,
        version,
        db: data.db === true,
        redis: data.redis === true,
      };
    }
    if (result.ok || result.status === 503) {
      return {
        state: 'degraded',
        label: '服务异常',
        detail: `HTTP ${result.status} · 数据库 ${data.db ? '正常' : '异常'} · Redis ${
          data.redis ? '正常' : '异常'
        }`,
        version,
      };
    }
    return {
      state: 'unreachable',
      label: '无法连接',
      detail: `HTTP ${result.status || '无响应'}`,
    };
  } catch (err) {
    // Failed to fetch：后端没起 / 网络不通 / 地址不在 host_permissions 白名单
    return {
      state: 'unreachable',
      label: '无法连接',
      detail: String(err?.message || err || '网络不可达'),
    };
  }
}
