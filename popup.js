// popup.js 渲染逻辑增强
import { API_BASE_URL, QUALITY_LABELS } from './config.js';
import { getConfig } from './utils.js';

function getQualityInfo(url) {
  for (let q of QUALITY_LABELS) {
    if (url.includes(q.key)) return q;
  }
  return { label: '未知', color: '#666' };
}

const listDiv = document.getElementById('list');

// // 渲染函数
// chrome.storage.local.get(['streams'], (result) => {
//   const streams = result.streams || [];
//   const listDiv = document.getElementById('list');

//   if (streams.length === 0) {
//     listDiv.innerHTML = '<p style="color: #999; text-align: center;">暂无流地址</p>';
//     return;
//   }

//   // 倒序排列，最新的流在最上面
//   [...streams].reverse().forEach((url) => {
//     const quality = getQualityInfo(url);
//     const item = document.createElement('div');
//     item.className = 'stream-item';

//     item.innerHTML = `
//       <div class="stream-info">
//         <span class="quality-tag" style="background: ${quality.color}">${quality.label}</span>
//         <span class="stream-type">FLV</span>
//       </div>
//       <div class="url-display">${url}</div>
//       <div class="action-area">
//         <button class="btn-send" data-url="${url}">🚀 开始录制</button>
//       </div>
//     `;
//     listDiv.appendChild(item);

//     // --- 核心：在这里插入状态读取代码 ---
//     const currentBtn = item.querySelector('.btn-send');
//     const statusKey = `status_${url}`;

//     chrome.storage.local.get([statusKey], (res) => {
//       if (res[statusKey] === 'auto-recorded') {
//         currentBtn.innerText = '✅ 正在录制中';
//         currentBtn.disabled = true;
//         currentBtn.style.background = '#4CAF50';
//         currentBtn.style.cursor = 'not-allowed';
//       }
//     });
//   });
// });
// 1. 封装渲染逻辑，方便多次调用
function renderList() {
  chrome.storage.local.get(['streams'], (result) => {
    const streams = result.streams || [];
    const listDiv = document.getElementById('list');

    // 清空旧列表，防止重复堆叠
    listDiv.innerHTML = '';

    if (streams.length === 0) {
      listDiv.innerHTML = '<p style="color: #999; text-align: center;">暂无流地址</p>';
      return;
    }

    // 倒序排列，最新的流在最上面
    [...streams].reverse().forEach((url) => {
      const quality = getQualityInfo(url);
      const item = document.createElement('div');
      item.className = 'stream-item';

      item.innerHTML = `
        <div class="stream-info">
          <span class="quality-tag" style="background: ${quality.color}">${quality.label}</span>
          <span class="stream-type">FLV</span>
        </div>
        <div class="url-display">${url}</div>
        <div class="action-area">
          <button class="btn-send" data-url="${url}">🚀 开始录制</button>
        </div>
      `;
      listDiv.appendChild(item);

      // --- 核心：在这里插入状态读取代码 ---
      const currentBtn = item.querySelector('.btn-send');
      const statusKey = `status_${url}`;

      chrome.storage.local.get([statusKey], (res) => {
        if (res[statusKey] === 'auto-recorded') {
          currentBtn.innerText = '✅ 正在录制中';
          currentBtn.disabled = true;
          currentBtn.style.background = '#4CAF50';
          currentBtn.style.cursor = 'not-allowed';
        }
      });
    });
  });
}

// 2. 页面首次打开时，执行一次初始化渲染
renderList();

// 3. 读取并初始化监听开关状态
chrome.storage.sync.get('monitorEnabled', (result) => {
  const toggle = document.getElementById('monitorToggle');
  toggle.checked = result.monitorEnabled !== false;
  toggle.addEventListener('change', () => {
    const enabled = toggle.checked;
    chrome.storage.sync.set({ monitorEnabled: enabled });
    chrome.runtime.sendMessage({ action: 'toggle_monitor', enabled });
  });
});

// 4. 核心：监听存储变化
chrome.storage.onChanged.addListener((changes, areaName) => {
  // 检查是否是我们要找的 local 存储，且 streams 发生了变化
  if (areaName === 'local' && changes.streams) {
    console.log('检测到数据更新，正在重新渲染列表...');
    renderList(); // 数据变了，立即刷新 UI
  }
});

// 处理点击发送
document.addEventListener('click', async (e) => {
  if (e.target.classList.contains('btn-send')) {
    const streamUrl = e.target.getAttribute('data-url');

    // --- 核心逻辑：获取当前活动的标签页 ---
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabTitle = tab?.title || '未知标题';
    const tabUrl = tab?.url || '';
    // ------------------------------------

    const config = await getConfig();

    fetch(config.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: streamUrl,
        title: tabTitle,
        room_url: tabUrl,
      }),
    })
      .then(() => {
        e.target.innerText = '✅ 已发送';
        e.target.style.background = '#4CAF50';
      })
      .catch((err) => alert('后端未启动或发送失败'));
  }

  // 2. 修正清空按钮逻辑：检查 e.target.id
  if (e.target.id === 'clearBtn') {
    console.log('清空按钮被点击');
    // 发送消息给 background.js 彻底清除数据
    chrome.runtime.sendMessage({ action: 'clear_count' }, () => {
      // 清除 UI 上的列表
      document.getElementById('list').innerHTML = '<p style="color: #999; text-align: center;">暂无流地址</p>';
      // 关闭弹窗（可选）
      setTimeout(() => window.close(), 500);
    });
  }
});
