import { getConfig } from '../core/config.js';
import { getQualityInfo } from '../core/stream-quality.js';
import {
  isEnvironmentRecording,
  isRecordingAccepted,
  sendRecordingRequest,
} from '../core/recording.js';
import { fetchJson } from '../lib/http.js';
import { isSupportedLiveRoomUrl } from '../lib/url.js';
import { ACTIONS } from '../lib/constants.js';

const PLATFORM_LABELS = {
  kuaishou: '快手',
  xiaohongshu: '小红书',
  huya: '虎牙',
  douyin: '抖音',
  douyu: '斗鱼',
  bilibili: 'B站',
};

function padTime(value) {
  return `${value}`.padStart(2, '0');
}

function formatStreamTime(timestamp) {
  const date = timestamp ? new Date(timestamp) : new Date();
  if (Number.isNaN(date.getTime())) return '--';

  const now = new Date();
  const time = `${padTime(date.getHours())}:${padTime(date.getMinutes())}`;
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (sameDay) return time;
  return `${padTime(date.getMonth() + 1)}-${padTime(date.getDate())} ${time}`;
}

// 小红书直播 CDN 的清晰度无法从 URL 判断，Popup 打开时按需探测真实分辨率。
const probeCache = new Map();
const probeInFlight = new Map();
// 须大于服务端 PROBE_TIMEOUT_MS(6s)，让服务端先返回明确的 timeout 而不是连接被断开。
const PROBE_FETCH_TIMEOUT_MS = 12000;
const PROBE_RETRY_DELAY_MS = 1500;
const PROBE_REASON_LABELS = {
  busy: '服务端忙',
  timeout: '探测超时',
  probe_failed: 'ffprobe 失败',
  no_video_stream: '无视频轨',
  unsupported_url: '地址不支持',
  ffprobe_unavailable: 'ffprobe 不可用',
  parse_failed: '解析失败',
};

function isXhsLiveCdnUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      (host.endsWith('.xhscdn.com') || host.endsWith('.xhscdn.net')) &&
      host.startsWith('live')
    );
  } catch (_) {
    return false;
  }
}

/** 从环境的 notify 地址推导探测接口地址。 */
function probeApiUrl(env) {
  const base = env?.notifyApiUrl;
  if (typeof base !== 'string' || !base.includes('/notify/live_download')) {
    return '';
  }
  return base.replace('/notify/live_download', '/notify/probe_stream');
}

/** 统一返回 { ok, info?, reason?, detail? }，失败原因不再被静默吞掉。 */
async function probeStreamQuality(url, { ignoreCache = false } = {}) {
  if (!ignoreCache) {
    if (probeCache.has(url)) return probeCache.get(url);
    if (probeInFlight.has(url)) return probeInFlight.get(url);
  }

  const task = (async () => {
    try {
      const config = await getConfig();
      const env = config.environments.find(
        (item) => item.enabled && probeApiUrl(item)
      );
      if (!env) return { ok: false, reason: 'no_environment' };
      const result = await fetchJson(
        probeApiUrl(env),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        },
        PROBE_FETCH_TIMEOUT_MS
      );
      const data = result.data;
      if (!result.ok || data?.status !== 'ok') {
        const reason =
          typeof data?.message === 'string'
            ? data.message
            : `http_${result.status}`;
        const detail = typeof data?.detail === 'string' ? data.detail : '';
        console.warn('[Popup] 画质探测失败:', url, reason, detail);
        return { ok: false, reason, detail };
      }
      const info = data.data;
      probeCache.set(url, { ok: true, info });
      return { ok: true, info };
    } catch (err) {
      console.warn('[Popup] 画质探测异常:', url, err);
      return {
        ok: false,
        reason: 'network_error',
        detail: String(err?.message || err),
      };
    } finally {
      probeInFlight.delete(url);
    }
  })();

  probeInFlight.set(url, task);
  return task;
}

function probeFailureReason(result) {
  const label =
    PROBE_REASON_LABELS[result?.reason] || result?.reason || '探测失败';
  return result?.detail ? `${label}：${result.detail}` : label;
}

function qualityLabel(info) {
  if (!info?.height) return '未知';
  const res = info.height >= 2160 ? '4K' : `${info.height}p`;
  const codec = String(info.codec || '').toLowerCase();
  const codecLabel =
    codec === 'hevc' || codec === 'h265'
      ? 'HEVC'
      : codec === 'h264'
        ? 'H.264'
        : codec.toUpperCase();
  return codecLabel ? `${res} ${codecLabel}` : res;
}

function qualityColor(info) {
  const height = info?.height || 0;
  if (height >= 2160) return '#8b5cf6';
  if (height >= 1080) return '#ff5000';
  if (height >= 720) return '#1e90ff';
  return '#999';
}

function normalizeStream(stream) {
  if (!stream || typeof stream === 'string') {
    return {
      url: stream || '',
      title: '未知直播',
      roomUrl: '',
      capturedAt: null,
    };
  }

  return {
    url: stream.url || '',
    title: stream.title || '未知直播',
    roomUrl: stream.roomUrl || '',
    capturedAt: stream.capturedAt || null,
  };
}

// ========== 平台监听摘要（快手轮询 / 小红书开播发现） ==========

function buildPlatformRow(name, count, enabled, unit, title = '') {
  const row = document.createElement('div');
  row.className = 'platform-row';
  if (title) row.title = title;

  const label = document.createElement('div');
  label.className = 'platform-name';

  const dot = document.createElement('span');
  dot.className = 'platform-dot' + (enabled ? '' : ' off');

  const text = document.createElement('span');
  text.textContent = name;

  label.append(dot, text);

  const countEl = document.createElement('span');
  countEl.className = 'platform-count';
  countEl.textContent = enabled ? `${count} ${unit}` : '已停用';

  row.append(label, countEl);
  return row;
}

async function renderPlatformSummary() {
  const container = document.getElementById('platformSummary');
  if (!container) return;

  const config = await getConfig();
  const enabledEnvs = config.environments.filter((env) => env.enabled);
  const kuaishouAuthors = new Set();
  const xhsAuthors = new Set();
  for (const env of enabledEnvs) {
    for (const author of env.followedAuthors || []) kuaishouAuthors.add(author);
    for (const author of env.xiaohongshuAuthors || []) xhsAuthors.add(author);
  }

  const { monitorEnabled } = await chrome.storage.sync.get('monitorEnabled');
  const enabled = monitorEnabled !== false;

  container.replaceChildren(
    buildPlatformRow(
      '快手关注轮询',
      kuaishouAuthors.size,
      enabled,
      '位关注',
      [...kuaishouAuthors].join('、')
    ),
    buildPlatformRow(
      '小红书开播发现',
      xhsAuthors.size,
      enabled,
      '位监控',
      [...xhsAuthors].join('、')
    )
  );

  // 最近一次小红书发现结果，便于判断"为什么没自动录"
  const { xhsLastDiscovery } =
    await chrome.storage.local.get('xhsLastDiscovery');
  if (xhsLastDiscovery?.at) {
    const last = document.createElement('div');
    last.className = 'platform-last';
    last.title = xhsLastDiscovery.message || '';
    last.textContent = `最近：${xhsLastDiscovery.nickname || xhsLastDiscovery.roomId} · ${
      xhsLastDiscovery.ok ? '已上报' : '未录制'
    } · ${formatStreamTime(xhsLastDiscovery.at)}`;
    container.append(last);
  }
}

// ========== 当前录制（跨平台，来自各启用环境后端） ==========

function formatRecordingDuration(startedAt) {
  if (!startedAt) return '';
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return '';
  return `已录 ${formatDuration(Date.now() - started)}`;
}

function renderRecordingItem(room) {
  const item = document.createElement('div');
  item.className = 'recording-item';
  item.title = room.room_url || '';

  const head = document.createElement('div');
  head.className = 'recording-head';

  const badge = document.createElement('span');
  badge.className = `platform-badge ${room.platform || ''}`;
  badge.textContent = PLATFORM_LABELS[room.platform] || room.platform || '直播';

  const name = document.createElement('div');
  name.className = 'recording-name';
  name.textContent =
    room.room_name ||
    room.live_room_id ||
    (room.room_url || '').split('/').filter(Boolean).pop() ||
    '未知房间';

  head.append(badge, name);

  const meta = document.createElement('div');
  meta.className = 'recording-meta';
  const statusText = room.status === 'paused' ? '已暂停' : '录制中';
  const duration = formatRecordingDuration(room.started_at);
  meta.textContent = [room.envLabel, statusText, duration]
    .filter(Boolean)
    .join(' · ');

  item.append(head, meta);

  if (room.room_url) {
    item.addEventListener('click', () => {
      chrome.tabs.create({ url: room.room_url, active: true });
    });
  }
  return item;
}

let activeRecordingsLoading = false;

async function renderActiveRecordings() {
  const container = document.getElementById('recordingsStatus');
  const countEl = document.getElementById('recordingCount');
  if (!container || activeRecordingsLoading) return;
  activeRecordingsLoading = true;
  try {
    await loadActiveRecordings(container, countEl);
  } finally {
    activeRecordingsLoading = false;
  }
}

async function loadActiveRecordings(container, countEl) {
  const config = await getConfig();
  const enabledEnvs = config.environments.filter((env) => env.enabled);

  const rooms = [];
  let reachable = 0;
  for (const env of enabledEnvs) {
    try {
      const result = await fetchJson(
        `${env.statusApiUrl}?active=true&include_all=true`
      );
      reachable++;
      const list = result.data?.data?.rooms || [];
      for (const room of list) {
        rooms.push({ ...room, envLabel: env.label || env.name });
      }
    } catch (err) {
      console.warn(`[Popup][${env.name}] 获取录制状态失败:`, err.message);
    }
  }

  const seen = new Set();
  const unique = rooms.filter((room) => {
    const key = `${room.platform}|${
      room.live_room_id || room.live_url || room.room_url
    }`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (countEl) countEl.textContent = String(unique.length);
  container.innerHTML = '';

  if (unique.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'recordings-empty';
    if (enabledEnvs.length === 0) {
      empty.textContent = '未启用任何环境';
    } else if (reachable === 0) {
      empty.textContent = '无法获取录制状态';
    } else {
      empty.textContent = '暂无进行中的录制';
    }
    container.appendChild(empty);
    return;
  }

  for (const room of unique) {
    container.appendChild(renderRecordingItem(room));
  }
}

function renderList() {
  chrome.storage.local.get(['streams'], (result) => {
    const streams = (result.streams || [])
      .map(normalizeStream)
      .filter(
        (stream) => !stream.roomUrl || isSupportedLiveRoomUrl(stream.roomUrl)
      );
    const listDiv = document.getElementById('list');
    const emptyState = document.getElementById('emptyState');
    const streamCount = document.getElementById('streamCount');

    listDiv.innerHTML = '';
    streamCount.textContent = streams.length;

    if (streams.length === 0) {
      emptyState.classList.remove('hidden');
      return;
    }

    emptyState.classList.add('hidden');

    [...streams].reverse().forEach((stream) => {
      const { url, title, roomUrl, capturedAt } = stream;
      const quality = getQualityInfo(url);
      const item = document.createElement('div');
      item.className = 'stream-item';

      const head = document.createElement('div');
      head.className = 'stream-head';

      const titleRow = document.createElement('div');
      titleRow.className = 'stream-title-row';

      const titleEl = document.createElement('div');
      titleEl.className = 'stream-title';
      titleEl.textContent = title;

      const timeEl = document.createElement('span');
      timeEl.className = 'stream-time';
      timeEl.textContent = formatStreamTime(capturedAt);

      titleRow.append(titleEl, timeEl);

      const tags = document.createElement('div');
      tags.className = 'stream-tags';

      const qualityTag = document.createElement('span');
      qualityTag.className = 'quality-tag';
      qualityTag.style.background = quality.color;
      qualityTag.textContent = quality.label;

      // 小红书地址中没有清晰度信息，异步探测后回填真实分辨率/编码
      if (isXhsLiveCdnUrl(url)) {
        const showProbing = () => {
          qualityTag.textContent = '探测中…';
          qualityTag.style.background = '#999';
          qualityTag.classList.remove('probe-failed');
        };
        const applyResult = (result) => {
          if (!qualityTag.isConnected) return;
          if (!result?.ok) {
            qualityTag.textContent = '探测失败';
            qualityTag.style.background = '#999';
            qualityTag.title = `${probeFailureReason(result)}；点击重试`;
            qualityTag.classList.add('probe-failed');
            return;
          }
          const info = result.info;
          qualityTag.textContent = qualityLabel(info);
          qualityTag.style.background = qualityColor(info);
          qualityTag.classList.remove('probe-failed');
          qualityTag.title = info?.bit_rate
            ? `${(info.bit_rate / 1e6).toFixed(1)} Mbps`
            : '';
        };

        showProbing();
        const runProbe = (options) =>
          probeStreamQuality(url, options).then((result) => {
            // busy 属瞬时失败，延时自动重试一次，避免用户手动点
            if (!result?.ok && result?.reason === 'busy') {
              showProbing();
              return new Promise((resolve) =>
                setTimeout(
                  () => resolve(probeStreamQuality(url, { ignoreCache: true })),
                  PROBE_RETRY_DELAY_MS
                )
              );
            }
            return result;
          });

        qualityTag.addEventListener('click', () => {
          probeCache.delete(url);
          showProbing();
          runProbe({ ignoreCache: true }).then(applyResult);
        });
        runProbe().then(applyResult);
      }

      const typeTag = document.createElement('span');
      typeTag.className = 'stream-type';
      typeTag.textContent = 'FLV';

      tags.append(qualityTag, typeTag);
      head.append(titleRow, tags);

      const roomLink = document.createElement(roomUrl ? 'a' : 'div');
      roomLink.className = 'stream-room';
      roomLink.textContent = roomUrl || '未记录直播间地址';
      if (roomUrl) {
        roomLink.href = roomUrl;
        roomLink.target = '_blank';
        roomLink.rel = 'noreferrer';
      }

      const urlDisplay = document.createElement('div');
      urlDisplay.className = 'url-display';
      urlDisplay.textContent = url;

      const button = document.createElement('button');
      button.className = 'btn-send';
      button.dataset.url = url;
      button.dataset.title = title;
      button.dataset.roomUrl = roomUrl;
      button.textContent = '🚀 开始录制';

      item.append(head, roomLink, urlDisplay, button);
      listDiv.appendChild(item);

      const currentBtn = item.querySelector('.btn-send');
      const statusKey = `status_${url}`;

      chrome.storage.local.get([statusKey], (res) => {
        if (res[statusKey] === 'auto-recorded') {
          currentBtn.textContent = '✅ 录制中';
          currentBtn.disabled = true;
        }
      });
    });
  });
}

function updateRequestDataUI() {
  chrome.storage.local.get(['lastReqStatus'], (localResult) => {
    const { time, result } = localResult.lastReqStatus || {};

    const domTime = document.getElementById('lastReqTime');
    if (domTime && time) {
      domTime.innerText = new Date(time).toLocaleString();
    }

    const el = document.getElementById('lastResult');
    if (el && result) {
      if (typeof result === 'object') {
        let text = result.status === 200 ? '✅ ' : '❌ ';
        text += '开播列表：' + (result.onlineAuthors || '无');
        el.innerText = text;
      } else {
        el.innerText =
          result.length > 20 ? result.substring(0, 20) + '...' : result;
      }
    }
  });
}

// ========== 立即检测 ==========

const SKIP_REASONS = {
  busy: '上一次检测还没结束，请稍等',
  disabled: '监听已停用，请先启用',
  recording: '正在录制中，已跳过本次检测',
  no_kuaishou_cookie: '还没访问过快手，请先打开一次 live.kuaishou.com',
  no_authors: '没有配置关注的主播',
  request_failed: '快手接口请求失败',
  error: '检测异常，请查看后台日志',
};

function setCheckNowState(btn, text, disabled) {
  btn.textContent = text;
  btn.disabled = disabled;
}

function handleCheckNow() {
  const btn = document.getElementById('checkNowBtn');
  if (!btn || btn.disabled) return;

  setCheckNowState(btn, '⏳ 检测中…', true);
  chrome.runtime.sendMessage({ action: ACTIONS.CHECK_NOW }, (response) => {
    // Popup 可能在等待期间被关闭，回调里 DOM 已不可用
    if (!document.getElementById('checkNowBtn')) return;

    if (chrome.runtime.lastError || !response) {
      setCheckNowState(btn, '❌ 检测失败', false);
      setTimeout(() => setCheckNowState(btn, '⚡ 立即检测', false), 2000);
      return;
    }

    if (response.status === 'error') {
      setCheckNowState(btn, '❌ 检测失败', false);
      setTimeout(() => setCheckNowState(btn, '⚡ 立即检测', false), 2000);
      return;
    }

    if (response.ran) {
      setCheckNowState(btn, '✅ 检测完成', false);
      // 结果本身由 storage 变更驱动 updateRequestDataUI() 渲染
      setTimeout(() => setCheckNowState(btn, '⚡ 立即检测', false), 2000);
      return;
    }

    const reason = SKIP_REASONS[response.reason] || '本次未执行检测';
    setCheckNowState(btn, `⚠ ${reason}`, false);
    setTimeout(() => setCheckNowState(btn, '⚡ 立即检测', false), 3000);
  });
}

function updateToggleUI(enabled) {
  const toggleBtn = document.getElementById('toggleButton');
  const toggleIcon = document.getElementById('toggleIcon');
  const statusText = document.getElementById('statusText');
  const statusDetail = document.getElementById('statusDetail');

  if (enabled) {
    toggleBtn.className = 'toggle-button on';
    toggleIcon.textContent = '📹';
    statusText.className = 'status-text on';
    statusText.textContent = '监听中';
    statusDetail.textContent = '快手轮询 + 小红书发现';
  } else {
    toggleBtn.className = 'toggle-button off';
    toggleIcon.textContent = '📹';
    statusText.className = 'status-text off';
    statusText.textContent = '已停用';
    statusDetail.textContent = '点击按钮启用开播发现';
  }
}

// ========== 弹幕采集状态 ==========

function formatDuration(ms) {
  if (!ms || ms < 0) return '0s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m${secs}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

function renderDanmakuStatus() {
  chrome.runtime.sendMessage({ action: 'get_danmaku_status' }, (response) => {
    const container = document.getElementById('danmakuStatus');
    if (!container) return;

    // 更新弹幕开关 UI
    const toggle = document.getElementById('danmakuToggle');
    const switchLabel = document.getElementById('danmakuSwitchLabel');
    const enabled = response?.danmakuEnabled ?? false;
    if (toggle) {
      toggle.checked = enabled;
    }
    if (switchLabel) {
      switchLabel.textContent = enabled ? '开' : '关';
    }

    const sessions = response?.sessions || [];

    if (sessions.length === 0) {
      container.innerHTML =
        '<div class="danmaku-empty">暂无活跃的弹幕会话</div>';
      return;
    }

    container.innerHTML = '';
    for (const session of sessions) {
      const item = document.createElement('div');
      item.className = 'danmaku-item';

      // 头部：房间名 + 状态徽章
      const head = document.createElement('div');
      head.className = 'danmaku-item-head';

      const room = document.createElement('div');
      room.className = 'danmaku-room';
      room.textContent =
        session.title ||
        session.roomUrl.split('/u/')[1] ||
        session.roomUrl.split('/livestream/')[1] ||
        '未知房间';
      room.title = session.roomUrl;

      const badge = document.createElement('span');
      badge.className = 'danmaku-badge';
      if (session.stopping) {
        badge.classList.add('stopped');
        badge.textContent = '已停止';
      } else if (session.isSending) {
        badge.classList.add('sending');
        badge.textContent = '采集中';
      } else {
        badge.classList.add('buffering');
        badge.textContent = '等待录制';
      }

      head.append(room, badge);
      item.appendChild(head);

      // 统计行
      const stats = document.createElement('div');
      stats.className = 'danmaku-stats';
      const duration = formatDuration(Date.now() - session.startedAt);
      const tabInfo = session.hasAutoTab ? ' · 后台标签页已打开' : '';
      stats.textContent = `已采集 ${session.eventCount} 条 · 缓冲 ${session.bufferSize} 条 · 运行 ${duration}${tabInfo}`;
      item.appendChild(stats);

      // 状态引导
      let guidanceText = '';
      let actionable = false;
      if (session.stopping) {
        guidanceText = '会话正在关闭中，刷新页面可重新开始采集';
      } else if (!session.isSending) {
        guidanceText = '录制尚未开始，弹幕已缓冲等待发送';
        actionable = true;
      } else if (session.isSending && session.eventCount === 0) {
        guidanceText = '点击打开直播间检查弹幕是否正常加载';
        actionable = true;
      }

      if (guidanceText) {
        const guidance = document.createElement('div');
        guidance.className =
          'danmaku-guidance' + (actionable ? ' actionable' : '');
        guidance.textContent = guidanceText;

        if (actionable && !session.isSending) {
          guidance.addEventListener('click', () => {
            guidance.textContent = '正在重试...';
            guidance.style.pointerEvents = 'none';
            chrome.runtime.sendMessage(
              { action: ACTIONS.RETRY_DANMAKU_STATUS },
              (resp) => {
                if (resp?.activated > 0) {
                  guidance.textContent = `已恢复 ${resp.activated} 个会话`;
                } else {
                  guidance.textContent = '重试未成功，后端可能未在录制';
                }
                setTimeout(renderDanmakuStatus, 2000);
              }
            );
          });
        } else if (actionable && session.roomUrl) {
          guidance.addEventListener('click', () => {
            chrome.tabs.create({ url: session.roomUrl, active: true });
          });
        }

        item.appendChild(guidance);
      }

      container.appendChild(item);
    }
  });
}

renderList();
updateRequestDataUI();
renderDanmakuStatus();
renderPlatformSummary();
renderActiveRecordings();
setInterval(renderDanmakuStatus, 3000);
setInterval(renderActiveRecordings, 5000);

chrome.storage.sync.get('monitorEnabled', (result) => {
  const enabled = result.monitorEnabled !== false;
  updateToggleUI(enabled);

  document.getElementById('toggleButton').addEventListener('click', () => {
    const newEnabled = !document
      .getElementById('toggleButton')
      .classList.contains('on');
    chrome.storage.sync.set({ monitorEnabled: newEnabled });
    chrome.runtime.sendMessage({
      action: 'toggle_monitor',
      enabled: newEnabled,
    });
    updateToggleUI(newEnabled);
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  if (changes.streams) {
    renderList();
  }

  if (changes.lastReqStatus && changes.lastReqStatus.newValue) {
    updateRequestDataUI();
  }

  if (changes.xhsLastDiscovery) {
    renderPlatformSummary();
  }
});

// 弹幕采集开关变更时同步 UI（background 自动切换时触发）
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  if (changes.danmakuEnabled !== undefined) {
    renderDanmakuStatus();
  }
  if (
    changes.environments !== undefined ||
    changes.monitorEnabled !== undefined
  ) {
    renderPlatformSummary();
    renderActiveRecordings();
  }
});

// 弹幕采集开关交互
document.getElementById('danmakuToggle').addEventListener('change', (e) => {
  const enabled = e.target.checked;
  chrome.runtime.sendMessage({ action: 'toggle_danmaku', enabled }, () => {
    renderDanmakuStatus();
  });
});

// 立即检测：取消当前 interval 计时，立刻查一次关注列表，然后重新开始计时
document
  .getElementById('checkNowBtn')
  .addEventListener('click', handleCheckNow);

// 设置入口
document.getElementById('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// 监听 background.js 的录制被拒通知，清除过期的"录制中"标记
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'recording_rejected' && request.streamUrl) {
    const statusKey = `status_${request.streamUrl}`;
    chrome.storage.local.remove(statusKey, () => {
      renderList();
    });
  }
});

document.addEventListener('click', async (e) => {
  if (
    e.target.classList.contains('btn-send') ||
    e.target.closest('.btn-send')
  ) {
    const btn = e.target.classList.contains('btn-send')
      ? e.target
      : e.target.closest('.btn-send');
    const streamUrl = btn.getAttribute('data-url');
    const title = btn.getAttribute('data-title');
    const roomUrl = btn.getAttribute('data-room-url');

    const config = await getConfig();
    let successCount = 0;

    for (const env of config.environments) {
      if (!env.enabled) continue;

      try {
        if (await isEnvironmentRecording(env, roomUrl)) {
          successCount++;
          continue;
        }

        const result = await sendRecordingRequest(
          env,
          streamUrl,
          title,
          roomUrl
        );

        if (isRecordingAccepted(result)) {
          successCount++;
        }
      } catch (err) {
        console.error('发送失败：', err);
      }
    }

    if (successCount > 0) {
      btn.textContent = '✅ 已发送';
      btn.disabled = true;
    } else {
      btn.textContent = '❌ 发送失败';
      setTimeout(() => {
        btn.textContent = '🚀 重试';
        btn.disabled = false;
      }, 2000);
    }
  }

  if (e.target.id === 'clearBtn') {
    chrome.runtime.sendMessage({ action: 'clear_count' }, () => {
      document.getElementById('list').innerHTML = '';
      document.getElementById('emptyState').classList.remove('hidden');
      document.getElementById('streamCount').textContent = '0';
      setTimeout(() => window.close(), 300);
    });
  }
});
