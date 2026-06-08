// core/stream-quality.js
// 清晰度权重、画质选择（平台相关业务逻辑）
// 从 config.js 提取清晰度权重/标签数据
// 从 background.js 提取 getQualityWeight()
// 从 popup.js 提取 getQualityInfo()

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

export function getQualityWeight(url) {
  for (let key in QUALITY_WEIGHTS) {
    if (url.includes(key)) return QUALITY_WEIGHTS[key];
  }
  return 0;
}

export function getQualityInfo(url) {
  for (let q of QUALITY_LABELS) {
    if (url.includes(q.key)) return q;
  }
  return { label: '未知', color: '#666' };
}
