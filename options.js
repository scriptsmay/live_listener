// options.js
import { DEFAULT_SETTINGS, FOLLOWED_AUTHORS } from './config.js';

// 初始化页面
document.addEventListener('DOMContentLoaded', async () => {
  const data = await chrome.storage.sync.get(['apiUrl', 'followedAuthors']);
  document.getElementById('apiUrl').value = data.apiUrl || DEFAULT_SETTINGS.apiUrl;
  const authors = data.followedAuthors?.length ? data.followedAuthors : FOLLOWED_AUTHORS;
  document.getElementById('followedAuthors').value = authors.join('\n');
});

// 保存逻辑
document.getElementById('save').addEventListener('click', () => {
  const newUrl = document.getElementById('apiUrl').value;
  const raw = document.getElementById('followedAuthors').value;
  const authors = raw
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
  chrome.storage.sync.set({ apiUrl: newUrl, followedAuthors: authors }, () => {
    chrome.runtime.sendMessage({ action: 'recheck_following' });
    alert('配置已更新，已开始重新检测');
  });
});
