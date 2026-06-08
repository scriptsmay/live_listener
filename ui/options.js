import { CONFIG_VERSION, DEFAULT_ENVIRONMENTS, getConfig } from '../core/config.js';

function createEnvField(labelText, control) {
  const field = document.createElement('div');
  field.className = 'env-field';

  const label = document.createElement('label');
  label.textContent = labelText;

  field.append(label, control);
  return field;
}

function renderEnvCard(env) {
  const card = document.createElement('div');
  card.className = `env-card ${env.name}`;

  const header = document.createElement('div');
  header.className = 'env-header';

  const title = document.createElement('span');
  title.className = 'env-title';
  title.textContent = env.label;

  const toggle = document.createElement('label');
  toggle.className = 'env-toggle';

  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  enabled.className = 'env-enabled';
  enabled.checked = env.enabled;

  toggle.append(enabled, document.createTextNode('启用'));
  header.append(title, toggle);

  const baseUrl = document.createElement('input');
  baseUrl.type = 'text';
  baseUrl.className = 'env-base-url';
  baseUrl.value = env.baseUrl;
  baseUrl.placeholder = env.baseUrl;

  const authors = document.createElement('textarea');
  authors.className = 'env-followed-authors';
  authors.rows = 5;
  authors.placeholder = 'KSG无言';
  authors.value = (env.followedAuthors || []).join('\n');

  card.append(
    header,
    createEnvField('服务地址（Base URL）', baseUrl),
    createEnvField('关注的主播（每行一个）', authors)
  );
  return card;
}

function parseAuthors(raw) {
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeBaseUrl(raw) {
  return raw.trim().replace(/\/$/, '');
}

function isValidBaseUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function isHostAllowed(patternHost, hostname) {
  if (patternHost === '*') return true;
  if (patternHost.startsWith('*.')) {
    const domain = patternHost.slice(2);
    return hostname === domain || hostname.endsWith(`.${domain}`);
  }
  return patternHost === hostname;
}

function matchesHostPermission(pattern, url) {
  const match = pattern.match(/^(\*|https?|file):\/\/([^/:]+)(?::(\*|\d+))?\//);
  if (!match) return false;

  const [, scheme, host, port] = match;
  const urlScheme = url.protocol.slice(0, -1);
  if (scheme !== '*' && scheme !== urlScheme) return false;
  if (!isHostAllowed(host, url.hostname)) return false;
  if (port && port !== '*' && port !== url.port) return false;

  return true;
}

function isAllowedBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  const permissions = chrome.runtime.getManifest().host_permissions || [];
  return permissions.some((pattern) => matchesHostPermission(pattern, url));
}

function getEnvData(env, card) {
  return {
    name: env.name,
    label: env.label,
    enabled: card.querySelector('.env-enabled').checked,
    baseUrl: normalizeBaseUrl(card.querySelector('.env-base-url').value),
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

const saveButton = document.getElementById('save');

function resetButton() {
  saveButton.innerText = '保存';
  saveButton.disabled = false;
}

saveButton.addEventListener('click', () => {
  const environments = [];
  const container = document.getElementById('envContainer');
  for (let i = 0; i < container.children.length; i++) {
    const card = container.children[i];
    const env = getEnvData(DEFAULT_ENVIRONMENTS[i], card);
    if (!isValidBaseUrl(env.baseUrl)) {
      alert(`${env.label} 的服务地址格式不正确`);
      return;
    }
    if (!isAllowedBaseUrl(env.baseUrl)) {
      alert(`${env.label} 的服务地址未在 manifest 权限中声明`);
      return;
    }
    environments.push(env);
  }

  chrome.storage.sync.set(
    { configVersion: CONFIG_VERSION, environments },
    () => {
      chrome.runtime.sendMessage({ action: 'recheck_following' });
      saveButton.innerText = '保存成功';
      saveButton.disabled = true;
      setTimeout(resetButton, 2000);
    }
  );
});

loadSettings();
