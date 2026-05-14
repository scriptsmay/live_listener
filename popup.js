const listDiv = document.getElementById('list');

// 从存储中读取地址并渲染
chrome.storage.local.get(['streams'], (result) => {
  const streams = result.streams || [];
  if (streams.length === 0) {
    listDiv.innerHTML = '<p style="color: #999; text-align: center;">暂无流地址</p>';
    return;
  }

  streams.forEach((url, index) => {
    const item = document.createElement('div');
    item.className = 'stream-item';
    item.innerHTML = `
      <div class="url">${url}</div>
      <button class="btn-send" data-url="${url}">🚀 发送至 NAS 录制</button>
    `;
    listDiv.appendChild(item);
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
