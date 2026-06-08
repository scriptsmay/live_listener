import { QUALITY_LABELS, getConfig } from './config.js';

const REQUEST_TIMEOUT_MS = 8000;

function getQualityInfo(url) {
  for (let q of QUALITY_LABELS) {
    if (url.includes(q.key)) return q;
  }
  return { label: '未知', color: '#666' };
}

async function fetchJson(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const text = await resp.text();
    let data = null;

    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_) {
        data = { raw: text };
      }
    }

    return {
      ok: resp.ok,
      status: resp.status,
      data,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function isEnvironmentRecording(env, roomUrl) {
  if (!roomUrl) return false;
  const result = await fetchJson(
    `${env.statusApiUrl}?url=${encodeURIComponent(roomUrl)}`
  );
  const data = result.data || {};

  return (
    result.ok &&
    data.exists &&
    (data.data?.status === 'recording' || data.data?.status === 'paused')
  );
}

async function sendRecordingRequest(env, streamUrl, title, roomUrl) {
  return fetchJson(env.notifyApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: streamUrl,
      title,
      room_url: roomUrl,
    }),
  });
}

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

function isKuaishouLiveRoomUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === 'live.kuaishou.com' &&
      /^\/u\/[^/?#]+/.test(parsed.pathname)
    );
  } catch (_) {
    return false;
  }
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

function renderList() {
  chrome.storage.local.get(['streams'], (result) => {
    const streams = (result.streams || [])
      .map(normalizeStream)
      .filter(
        (stream) => !stream.roomUrl || isKuaishouLiveRoomUrl(stream.roomUrl)
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
        // el.innerHTML = JSON.stringify(result, null, 2);
        // el.innerText = result.status === 200 ? '✅ 成功' : '❌ 失败';
      } else {
        el.innerText =
          result.length > 20 ? result.substring(0, 20) + '...' : result;
      }
    }
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
    statusDetail.textContent = '正在监控直播流';
  } else {
    toggleBtn.className = 'toggle-button off';
    toggleIcon.textContent = '📹';
    statusText.className = 'status-text off';
    statusText.textContent = '已停用';
    statusDetail.textContent = '点击按钮启用后台关注';
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
        session.title || session.roomUrl.split('/u/')[1] || '未知房间';
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
        // 等待录制状态——属于正常中间态，简要提示即可
        guidanceText = '录制尚未开始，弹幕已缓冲等待发送';
      } else if (session.isSending && session.eventCount === 0) {
        // 已开启发送但没有任何事件——采集脚本可能没有正常工作
        guidanceText = '点击打开直播间检查弹幕是否正常加载';
        actionable = true;
      }

      if (guidanceText) {
        const guidance = document.createElement('div');
        guidance.className =
          'danmaku-guidance' + (actionable ? ' actionable' : '');
        guidance.textContent = guidanceText;

        if (actionable && session.roomUrl) {
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
setInterval(renderDanmakuStatus, 3000);

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
});

// 弹幕采集开关变更时同步 UI（background 自动切换时触发）
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  if (changes.danmakuEnabled !== undefined) {
    renderDanmakuStatus();
  }
});

// 弹幕采集开关交互
document.getElementById('danmakuToggle').addEventListener('change', (e) => {
  const enabled = e.target.checked;
  chrome.runtime.sendMessage(
    { action: 'toggle_danmaku', enabled },
    () => {
      renderDanmakuStatus();
    }
  );
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

        if (result.ok) {
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
