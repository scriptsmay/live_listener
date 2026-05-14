// popup.js 渲染逻辑增强

// 定义关键词对应的显示文字和颜色
const qualityMap = [
  { key: 'FhdL4', label: '蓝光 8M', color: '#ff5000' },
  { key: 'Fhd', label: '全高清', color: '#ff8c00' },
  { key: 'HdL0', label: '高清', color: '#00bfff' },
  { key: 'HdL', label: '标准', color: '#1e90ff' },
  { key: 'Sd', label: '标清', color: '#999' },
];

function getQualityInfo(url) {
  for (let q of qualityMap) {
    if (url.includes(q.key)) return q;
  }
  return { label: '未知', color: '#666' };
}

const listDiv = document.getElementById('list');

// 渲染函数
chrome.storage.local.get(['streams'], (result) => {
  const streams = result.streams || [];
  const listDiv = document.getElementById('list');

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

// 处理点击发送
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('btn-send')) {
    const streamUrl = e.target.getAttribute('data-url');

    fetch('http://localhost:3210/api/notify/live_download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: streamUrl,
        title: 'KSLive_' + Date.now(),
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
