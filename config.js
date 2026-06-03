// config.js

export const FOLLOWED_AUTHORS = ['KSG无言'];
export const CONFIG_VERSION = 2;

// 通知直播间录制接口
export const NOTIFY_API_PATH = '/api/notify/live_download';
// 直播间录制状态查询
export const STATUS_API_PATH = '/api/notify/status';
// 弹幕收集接口，支持批量查询多个直播间的弹幕数据
export const DANMAKU_BATCH_API_PATH = '/api/danmaku/batch';

function buildEnvironment(baseUrl, overrides = {}) {
  return {
    baseUrl,
    notifyApiUrl: `${baseUrl}${NOTIFY_API_PATH}`,
    statusApiUrl: `${baseUrl}${STATUS_API_PATH}`,
    danmakuBatchApiUrl: `${baseUrl}${DANMAKU_BATCH_API_PATH}`,
    ...overrides,
  };
}

// 每个环境一个配置块，可在 options 页面独立开关
export const DEFAULT_ENVIRONMENTS = [
  buildEnvironment('http://192.168.31.247:11123', {
    name: 'production',
    label: '生产环境',
    enabled: true,
    followedAuthors: FOLLOWED_AUTHORS,
  }),
  buildEnvironment('http://localhost:3001', {
    name: 'development',
    label: '开发环境',
    enabled: false,
    followedAuthors: [],
  }),
];

// 定义关键词对应的显示文字和颜色
export const QUALITY_LABELS = [
  { key: 'Ultra4k', label: '4K', color: '#8b5cf6' },
  { key: 'FhdL4', label: '1080p 8M', color: '#ff5000' },
  { key: 'FhdL3', label: '1080p 6M', color: '#f36411' },
  { key: 'FhdL1', label: '1080p 2M', color: '#ff7a1a' },
  { key: 'Fhd', label: '1080p', color: '#ff8c00' },
  { key: 'HdL0', label: '超清', color: '#00bfff' },
  { key: 'HdL', label: '720p', color: '#1e90ff' },
  { key: 'Sd', label: '标清', color: '#999' },
  { key: 'Ld', label: '流畅', color: '#ccc' },
];

// 定义清晰度权重
export const QUALITY_WEIGHTS = {
  Ultra4k: 120,
  FhdL4: 100,
  FhdL3: 90,
  FhdL1: 84,
  Fhd: 80,
  HdL0: 50,
  HdL: 40,
  Sd: 10,
  Ld: 0,
};

export const POLL_INTERVAL_MINUTES = 1;

export const LIVING_API_URL =
  'https://live.kuaishou.com/live_api/follow/living';

function normalizeAuthors(authors) {
  return Array.isArray(authors)
    ? authors.map((author) => `${author}`.trim()).filter(Boolean)
    : null;
}

function normalizeBaseUrl(baseUrl) {
  return typeof baseUrl === 'string' ? baseUrl.replace(/\/$/, '') : '';
}

function inferBaseUrlFromUrl(url) {
  if (typeof url !== 'string') return '';
  const match = url.match(/^(https?:\/\/[^/]+)/);
  return match ? match[1] : '';
}

export async function getConfig() {
  const storage = await chrome.storage.sync.get(null);
  const storedEnvs = storage.environments || [];
  const legacyAuthors = normalizeAuthors(storage.followedAuthors);
  const environments = DEFAULT_ENVIRONMENTS.map((def) => {
    const stored = storedEnvs.find((e) => e.name === def.name);
    const storedAuthors = normalizeAuthors(stored?.followedAuthors);
    const defaultAuthors = normalizeAuthors(def.followedAuthors) || [];
    const storedBaseUrl =
      normalizeBaseUrl(stored?.baseUrl) ||
      inferBaseUrlFromUrl(stored?.notifyApiUrl) ||
      inferBaseUrlFromUrl(stored?.statusApiUrl);
    const baseUrl = storedBaseUrl || def.baseUrl;
    return {
      ...def,
      baseUrl,
      enabled: stored?.enabled ?? def.enabled,
      notifyApiUrl: `${baseUrl}${NOTIFY_API_PATH}`,
      statusApiUrl: `${baseUrl}${STATUS_API_PATH}`,
      danmakuBatchApiUrl: `${baseUrl}${DANMAKU_BATCH_API_PATH}`,
      followedAuthors: storedAuthors ?? legacyAuthors ?? defaultAuthors,
    };
  });
  return {
    configVersion: CONFIG_VERSION,
    environments,
    // 兼容旧调用方，新代码应使用 environments[*].followedAuthors。
    followedAuthors: legacyAuthors ?? FOLLOWED_AUTHORS,
  };
}
