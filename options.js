// options.js
import { DEFAULT_SETTINGS } from './config.js';

// 初始化页面
document.addEventListener('DOMContentLoaded', async () => {
  // 从存储中获取，如果没有则使用 config.js 里的默认值
  const data = await chrome.storage.sync.get('apiUrl');
  document.getElementById('apiUrl').value = data.apiUrl || DEFAULT_SETTINGS.apiUrl;
});

// 保存逻辑
document.getElementById('save').addEventListener('click', () => {
  const newUrl = document.getElementById('apiUrl').value;
  chrome.storage.sync.set({ apiUrl: newUrl }, () => {
    alert('配置已更新');
  });
});
