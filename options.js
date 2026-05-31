import { DEFAULT_ENVIRONMENTS, getConfig } from './config.js';

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
    <div class="env-field">
      <label>关注的主播（每行一个）</label>
      <textarea class="env-followed-authors" rows="5" placeholder="KSG无言"></textarea>
    </div>
  `;
  card.querySelector('.env-followed-authors').value = (
    env.followedAuthors || []
  ).join('\n');
  return card;
}

function parseAuthors(raw) {
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function getEnvData(env, card) {
  return {
    name: env.name,
    label: env.label,
    enabled: card.querySelector('.env-enabled').checked,
    notifyApiUrl: card.querySelector('.env-notify-url').value,
    statusApiUrl: card.querySelector('.env-status-url').value,
    followedAuthors: parseAuthors(
      card.querySelector('.env-followed-authors').value
    ),
  };
}

async function loadSettings() {
  const config = await getConfig();
  const container = document.getElementById('envContainer');
  container.innerHTML = '';

  for (const def of DEFAULT_ENVIRONMENTS) {
    const merged = config.environments.find((e) => e.name === def.name) || def;
    const card = renderEnvCard(merged);
    container.appendChild(card);
  }
}

document.getElementById('save').addEventListener('click', () => {
  const environments = [];
  const container = document.getElementById('envContainer');
  for (let i = 0; i < container.children.length; i++) {
    const card = container.children[i];
    const env = getEnvData(DEFAULT_ENVIRONMENTS[i], card);
    environments.push(env);
  }

  chrome.storage.sync.set({ environments }, () => {
    chrome.runtime.sendMessage({ action: 'recheck_following' });
    alert('配置已更新，已开始重新检测');
  });
});

loadSettings();
