import { DEFAULT_SETTINGS, FOLLOWED_AUTHORS } from './config.js';

document.addEventListener('DOMContentLoaded', async () => {
  const data = await chrome.storage.sync.get(['notifyApiUrl', 'statusApiUrl', 'followedAuthors']);
  document.getElementById('notifyApiUrl').value = data.notifyApiUrl || DEFAULT_SETTINGS.notifyApiUrl;
  document.getElementById('statusApiUrl').value = data.statusApiUrl || DEFAULT_SETTINGS.statusApiUrl;
  const authors = data.followedAuthors?.length ? data.followedAuthors : FOLLOWED_AUTHORS;
  document.getElementById('followedAuthors').value = authors.join('\n');
});

document.getElementById('save').addEventListener('click', () => {
  const notifyApiUrl = document.getElementById('notifyApiUrl').value;
  const statusApiUrl = document.getElementById('statusApiUrl').value;
  const raw = document.getElementById('followedAuthors').value;
  const authors = raw
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
  chrome.storage.sync.set({ notifyApiUrl, statusApiUrl, followedAuthors: authors }, () => {
    chrome.runtime.sendMessage({ action: 'recheck_following' });
    alert('配置已更新，已开始重新检测');
  });
});
