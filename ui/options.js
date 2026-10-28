import { CONFIG_VERSION, DEFAULT_ENVIRONMENTS, getConfig } from '../core/config.js';
import { ACTIONS } from '../lib/constants.js';

// ========== 关注列表轮询状态 ==========
//
// 只读展示：间隔从 config.js 的 POLL_INTERVAL_MINUTES 读（经后台返回，避免
// options 页重复计算），下次请求时间取自 chrome.alarms 的 scheduledTime。
// 注意这里不 import following-poll.js —— 那条依赖链会在页面上下文里连带
// 求值 recording.js / danmaku-session.js 并注册监听器。

let pollSchedule = null;

function pad(value) {
  return `${value}`.padStart(2, '0');
}

function formatClock(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
    date.getSeconds()
  )}`;
}

function formatInterval(seconds) {
  if (!seconds) return '--';
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

function formatCountdown(ms) {
  if (ms <= 0) return '即将触发';
  const total = Math.ceil(ms / 1000);
  return total < 60
    ? `${total} 秒后`
    : `${Math.floor(total / 60)} 分 ${total % 60} 秒后`;
}

function renderSchedule() {
  const badge = document.getElementById('pollBadge');
  const intervalEl = document.getElementById('pollInterval');
  const nextEl = document.getElementById('pollNextRun');
  const countdownEl = document.getElementById('pollCountdown');
  const hintEl = document.getElementById('pollHint');
  if (!badge) return;

  if (!pollSchedule) {
    badge.textContent = '读取中…';
    badge.className = 'poll-badge';
    return;
  }

  intervalEl.textContent = formatInterval(pollSchedule.intervalSeconds);

  const { active, scheduledTime } = pollSchedule;
  badge.textContent = active ? '运行中' : '未注册';
  badge.className = `poll-badge ${active ? 'on' : 'off'}`;

  if (!scheduledTime) {
    nextEl.textContent = '--';
    countdownEl.textContent = '--';
    hintEl.textContent = active
      ? '后台每分钟检测一次关注列表；每次请求前另有 2~6 秒随机延迟防风控。'
      : '未检测到轮询 alarm，重新加载扩展会自动重建。';
    return;
  }

  nextEl.textContent = formatClock(new Date(scheduledTime));
  countdownEl.textContent = formatCountdown(scheduledTime - Date.now());
  hintEl.textContent =
    '后台每分钟检测一次关注列表；每次请求前另有 2~6 秒随机延迟防风控。' +
    '在 Popup 点「立即检测」会重置该计时。';
}

function refreshPollSchedule() {
  chrome.runtime.sendMessage(
    { action: ACTIONS.GET_POLL_SCHEDULE },
    (response) => {
      if (chrome.runtime.lastError) {
        pollSchedule = null;
      } else if (response) {
        pollSchedule = response;
      }
      renderSchedule();
    }
  );
}

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
refreshPollSchedule();

// 本地秒级刷新倒计时（纯 UI 计算，不查后台），并每 10 秒从后台重取一次
// scheduledTime —— 手动检测 / SW 重启都会重建 alarm，时间会变。
setInterval(() => {
  renderSchedule();
}, 1000);
setInterval(refreshPollSchedule, 10000);
