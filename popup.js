import { QUALITY_LABELS, getConfig } from './config.js';

function getQualityInfo(url) {
  for (let q of QUALITY_LABELS) {
    if (url.includes(q.key)) return q;
  }
  return { label: '未知', color: '#666' };
}

function renderList() {
  chrome.storage.local.get(['streams'], (result) => {
    const streams = result.streams || [];
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
      const { url, title, roomUrl } = stream;
      const quality = getQualityInfo(url);
      const item = document.createElement('div');
      item.className = 'stream-item';

      item.innerHTML = `
        <div class="stream-meta">
          <span class="quality-tag" style="background: ${quality.color}">${quality.label}</span>
          <span class="stream-type">FLV</span>
        </div>
        <div class="url-display">${url}</div>
        <button class="btn-send" data-url="${url}" data-title="${title}" data-room-url="${roomUrl}">
          🚀 开始录制
        </button>
      `;
      listDiv.appendChild(item);

      const currentBtn = item.querySelector('.btn-send');
      const statusKey = `status_${url}`;

      chrome.storage.local.get([statusKey], (res) => {
        if (res[statusKey] === 'auto-recorded') {
          currentBtn.innerHTML = '✅ 录制中';
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
    statusDetail.textContent = '点击按钮启用';
  }
}

renderList();
updateRequestDataUI();

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
        const res = await fetch(env.notifyApiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: streamUrl,
            title: title,
            room_url: roomUrl,
          }),
        });

        if (res.ok) {
          successCount++;
        }
      } catch (err) {
        console.error('发送失败：', err);
      }
    }

    if (successCount > 0) {
      btn.innerHTML = '✅ 已发送';
      btn.disabled = true;
    } else {
      btn.innerHTML = '❌ 发送失败';
      setTimeout(() => {
        btn.innerHTML = '🚀 重试';
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
