// utils.js
import { DEFAULT_SETTINGS } from './config.js';

/**
 * 获取合并后的配置：优先从 storage 取，没有则用 config.js 的默认值
 */
export async function getConfig() {
  // 从 storage 读取所有设置
  const storage = await chrome.storage.sync.get(null);

  return {
    apiUrl: storage.apiUrl || DEFAULT_SETTINGS.apiUrl,
    // 如果以后有更多字段，直接在这里添加
  };
}
