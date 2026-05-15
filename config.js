// config.js
export const ENVIRONMENTS = {
  production: {
    label: '生产环境',
    notifyApiUrl: 'http://localhost:1123/api/notify/live_download',
    statusApiUrl: 'http://localhost:1123/api/notify/status',
  },
  development: {
    label: '开发环境',
    notifyApiUrl: 'http://localhost:3001/api/notify/live_download',
    statusApiUrl: 'http://localhost:3001/api/notify/status',
  },
};

export const NOTIFY_API_URL = ENVIRONMENTS.production.notifyApiUrl;
export const STATUS_API_URL = ENVIRONMENTS.production.statusApiUrl;

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

export const DEFAULT_SETTINGS = {
  env: 'production',
  notifyApiUrl: NOTIFY_API_URL,
  statusApiUrl: STATUS_API_URL,
  enableNotification: false,
  headers: {
    'Content-Type': 'application/json',
  },
};

export const FOLLOWED_AUTHORS = ['KSG无言'];

export const POLL_INTERVAL_MINUTES = 1;

export const LIVING_API_URL = 'https://live.kuaishou.com/live_api/follow/living';

export async function getConfig() {
  const storage = await chrome.storage.sync.get(null);
  const env = storage.env || DEFAULT_SETTINGS.env;
  const envUrls = ENVIRONMENTS[env] || ENVIRONMENTS.production;
  const manualUrls = storage.notifyApiUrl || storage.apiUrl;
  return {
    env,
    notifyApiUrl: manualUrls || envUrls.notifyApiUrl,
    statusApiUrl: storage.statusApiUrl || envUrls.statusApiUrl,
    followedAuthors: storage.hasOwnProperty('followedAuthors')
      ? storage.followedAuthors
      : FOLLOWED_AUTHORS,
  };
}
