// content.js
function sniffVideo() {
  const video = document.querySelector('video');
  if (video && video.currentSrc && video.currentSrc.startsWith('http')) {
    // 发送给 background.js 处理
    chrome.runtime.sendMessage({
      Message: 'addMedia',
      url: video.currentSrc,
    });
  }
}

// 轮询或通过事件监听
setInterval(sniffVideo, 3000);
