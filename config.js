// config.js
export const API_BASE_URL = 'http://localhost:1123/api/notify/live_download';

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
  FhdL4: 100, // 蓝光/全高清
  Fhd: 90,
  HdL0: 50, // 高清
  HdL: 40,
  Sd: 10, // 标清
};

export const DEFAULT_SETTINGS = {
  // API 地址
  apiUrl: API_BASE_URL,
  // 是否开启通知提示
  enableNotification: false,
  // 默认请求头
  headers: {
    'Content-Type': 'application/json',
  },
};

// 关注的主播列表 — 匹配 API 响应中的 author.name
export const FOLLOWED_AUTHORS = ['KSG无言'];

// 轮询检测开播的间隔（分钟）
export const POLL_INTERVAL_MINUTES = 1;

// 查询关注中主播的 API
export const LIVING_API_URL = 'https://live.kuaishou.com/live_api/follow/living';
