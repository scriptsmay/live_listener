# Live Stream Sniffer

Manifest V3 Chrome 扩展，用于监测快手直播流并推送到本地录制后端。

## 安装

1. 打开 `chrome://extensions`。
2. 开启开发者模式。
3. 选择“加载已解压的扩展程序”，加载本目录。
4. 修改 JS/HTML 后需要在扩展管理页手动重新加载扩展。

## 配置

在扩展详情页打开“扩展程序选项”。

每个环境配置：

- `Base URL`：后端地址，目前默认支持生产环境 `http://192.168.31.247:11123` 和开发环境 `http://localhost:3001`。
- `关注的主播`：每行一个主播名。
- `启用`：只有启用环境才会接收自动推送。

接口后缀由扩展固定拼接：

- 录制接口：`POST {baseUrl}/api/notify/live_download`
- 状态接口：`GET {baseUrl}/api/notify/status?url={roomUrl}`
- 弹幕接口：`POST {baseUrl}/api/danmaku/batch`

## 弹幕采集

扩展通过 `inject.js` 注入快手直播间页面，拦截 WebSocket 消息捕获弹幕（protobuf + JSON 双模式），经 `content.js` 转发给 `background.js`，每 5 秒批量发送到后端。

**录制状态感知**：弹幕发送与后端录制状态联动，仅在录制中时才向后端推送弹幕数据：

1. 进入直播间后创建弹幕会话，进入缓冲模式（采集但不发送）
2. 立即查询后端录制状态，如已在录制则马上开启发送
3. 定时器每 10 秒轮询一次后端录制状态，自动启停发送
4. 录制结束时刷新剩余缓冲后停止发送
5. 未录制期间弹幕保留在内存缓冲区（上限 5000 条，超出丢弃最早事件）

## 后端请求格式

录制请求 JSON：

```json
{
  "url": "直播流地址",
  "title": "标题或主播名",
  "room_url": "直播间地址",
  "caption": "直播描述"
}
```

状态接口需要返回：

```json
{
  "exists": true,
  "data": {
    "status": "recording"
  }
}
```

`status` 为 `recording` 或 `paused` 时，扩展会认为该环境已在录制。

## 手动验证

1. 先访问任意快手页面，确保浏览器已有快手登录 Cookie。
2. 打开 `https://live.kuaishou.com/my-follow/living`。
3. 打开一个正在直播的 `/u/...` 直播间。
4. Popup 中应只出现真实直播间流，不应出现 `/my-follow/living`。
5. 检查画质标签、房间地址、捕获时间和“开始录制”按钮。
6. 修改 Options 后保存，确认会触发重新检测。
