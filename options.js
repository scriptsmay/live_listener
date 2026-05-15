import { ENVIRONMENTS, DEFAULT_SETTINGS, FOLLOWED_AUTHORS } from './config.js';

document.addEventListener('DOMContentLoaded', async () => {
  const data = await chrome.storage.sync.get(['env', 'notifyApiUrl', 'statusApiUrl', 'followedAuthors']);
  const env = data.env || DEFAULT_SETTINGS.env;
  document.getElementById('envSelect').value = env;

  // 如果用户没手动改过 URL，用当前环境的默认值
  document.getElementById('notifyApiUrl').value =
    data.notifyApiUrl || ENVIRONMENTS[env].notifyApiUrl;
  document.getElementById('statusApiUrl').value =
    data.statusApiUrl || ENVIRONMENTS[env].statusApiUrl;

  const authors = data.followedAuthors?.length ? data.followedAuthors : FOLLOWED_AUTHORS;
  document.getElementById('followedAuthors').value = authors.join('\n');
});

// 切换环境时自动填充默认 URL（仅当用户没手动修改过才覆盖）
document.getElementById('envSelect').addEventListener('change', async (e) => {
  const env = e.target.value;
  const data = await chrome.storage.sync.get(['notifyApiUrl', 'statusApiUrl']);
  const urls = ENVIRONMENTS[env];
  // 如果用户没存过自定义 URL，自动回填；否则保留手动输入
  if (!data.notifyApiUrl) {
    document.getElementById('notifyApiUrl').value = urls.notifyApiUrl;
  }
  if (!data.statusApiUrl) {
    document.getElementById('statusApiUrl').value = urls.statusApiUrl;
  }
});

document.getElementById('save').addEventListener('click', () => {
  const env = document.getElementById('envSelect').value;
  const notifyApiUrl = document.getElementById('notifyApiUrl').value;
  const statusApiUrl = document.getElementById('statusApiUrl').value;
  const raw = document.getElementById('followedAuthors').value;
  const authors = raw
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
  chrome.storage.sync.set({ env, notifyApiUrl, statusApiUrl, followedAuthors: authors }, () => {
    chrome.runtime.sendMessage({ action: 'recheck_following' });
    alert('配置已更新，已开始重新检测');
  });
});
