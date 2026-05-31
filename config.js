// config.js

export const FOLLOWED_AUTHORS = ['KSG无言'];

export const NOTIFY_API_PATH = '/api/notify/live_download';
export const STATUS_API_PATH = '/api/notify/status';

function buildEnvironment(baseUrl, overrides = {}) {
  return {
    baseUrl,
    notifyApiUrl: `${baseUrl}${NOTIFY_API_PATH}`,
    statusApiUrl: `${baseUrl}${STATUS_API_PATH}`,
    ...overrides,
  };
}

// 每个环境一个配置块，可在 options 页面独立开关
export const DEFAULT_ENVIRONMENTS = [
  buildEnvironment('http://localhost:1123', {
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
  { key: 'FhdL4', label: '蓝光 8M', color: '#ff5000' },
  { key: 'Fhd', label: '全高清', color: '#ff8c00' },
  { key: 'HdL0', label: '高清', color: '#00bfff' },
  { key: 'HdL', label: '标准', color: '#1e90ff' },
  { key: 'Sd', label: '标清', color: '#999' },
];

// 定义清晰度权重
export const QUALITY_WEIGHTS = {
  FhdL4: 100,
  Fhd: 90,
  HdL0: 50,
  HdL: 40,
  Sd: 10,
};

export const POLL_INTERVAL_MINUTES = 1;

export const LIVING_API_URL = 'https://live.kuaishou.com/live_api/follow/living';

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
      followedAuthors: storedAuthors ?? legacyAuthors ?? defaultAuthors,
    };
  });
  return {
    environments,
    // 兼容旧调用方，新代码应使用 environments[*].followedAuthors。
    followedAuthors: legacyAuthors ?? FOLLOWED_AUTHORS,
  };
}
