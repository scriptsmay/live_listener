import { DEFAULT_ENVIRONMENTS, FOLLOWED_AUTHORS } from './config.js';

function renderEnvCard(env) {
  const card = document.createElement('div');
  card.className = `env-card ${env.name}`;
  card.innerHTML = `
    <div class="env-header">
      <span class="env-title">${env.label}</span><label class="env-toggle">
        <input type="checkbox" class="env-enabled" ${env.enabled ? 'checked' : ''}>
        启用
      </label>
    </div>
    <div class="env-field">
      <label>录制接口</label>
      <input type="text" class="env-notify-url" value="${env.notifyApiUrl}">
    </div>
    <div class="env-field">
      <label>状态查询接口</label>
      <input type="text" class="env-status-url" value="${env.statusApiUrl}">
    </div>
  `;
  return card;
}

function getEnvData(env, card) {
  return {
    name: env.name,
    label: env.label,
    enabled: card.querySelector('.env-enabled').checked,
    notifyApiUrl: card.querySelector('.env-notify-url').value,
    statusApiUrl: card.querySelector('.env-status-url').value,
  };
}

async function loadSettings() {
  const data = await chrome.storage.sync.get([
    'environments',
    'followedAuthors',
  ]);
  const storedEnvs = data.environments || [];
  const container = document.getElementById('envContainer');
  container.innerHTML = '';

  for (const def of DEFAULT_ENVIRONMENTS) {
    const stored = storedEnvs.find((e) => e.name === def.name);
    const merged = { ...def, ...stored };
    const card = renderEnvCard(merged);
    container.appendChild(card);
  }

  const authors = data.followedAuthors?.length
    ? data.followedAuthors
    : FOLLOWED_AUTHORS;
  document.getElementById('followedAuthors').value = authors.join('\n');
}

document.getElementById('save').addEventListener('click', () => {
  const environments = [];
  const container = document.getElementById('envContainer');
  for (let i = 0; i < container.children.length; i++) {
    const card = container.children[i];
    const env = getEnvData(DEFAULT_ENVIRONMENTS[i], card);
    environments.push(env);
  }

  const raw = document.getElementById('followedAuthors').value;
  const authors = raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  chrome.storage.sync.set({ environments, followedAuthors: authors }, () => {
    chrome.runtime.sendMessage({ action: 'recheck_following' });
    alert('配置已更新，已开始重新检测');
  });
});

loadSettings();
