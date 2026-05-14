// content.js
// 双重作用：
// 1. 检测 <video> 标签的 currentSrc，捕获 webRequest 可能遗漏的流地址
// 2. 周期性发送消息，作为 MV3 Service Worker 的心跳保活

function sniffVideo() {
  const video = document.querySelector('video');
  if (video && video.currentSrc && video.currentSrc.startsWith('http')) {
    chrome.runtime.sendMessage({
      Message: 'addMedia',
      url: video.currentSrc,
    });
  }
}

// 3 秒轮询：既是检测也是保活
setInterval(sniffVideo, 3000);
