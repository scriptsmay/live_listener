# Live Stream Sniffer

Manifest V3 Chrome 扩展，用于监测快手与小红书直播流、采集实时弹幕并推送到本地录制后端。

## 安装

1. 打开 `chrome://extensions`。
2. 开启开发者模式。
3. 选择“加载已解压的扩展程序”，加载本目录。
4. 修改 JS/HTML 后需要在扩展管理页手动重新加载扩展。

## 配置

在扩展详情页打开“扩展程序选项”。

每个环境配置：

- `Base URL`：后端地址，目前默认支持生产环境 `http://192.168.31.247:11123` 和开发环境 `http://localhost:3001`。
- `关注的主播（快手）`：每行一个主播名。
- `小红书监控`：每行一个监控对象，支持小红书号（`531916795`）、24 位用户 ID、主页/直播间链接、`昵称|ID` 或纯昵称。推荐使用用户 ID（稳定身份）。
- `启用`：只有启用环境才会接收自动推送。

接口后缀由扩展固定拼接：

- 录制接口：`POST {baseUrl}/api/notify/live_download`
- 状态接口：`GET {baseUrl}/api/notify/status?url={roomUrl}`（单房间）与 `GET {baseUrl}/api/notify/status?active=true`（服务端活跃弹幕采集任务列表）
- 弹幕接口：`POST {baseUrl}/api/danmaku/batch`

## 小红书开播发现（被动嗅探）

扩展不额外请求小红书接口、不逆向签名，只在页面自身请求返回时读取响应，命中监控主播后自动上报录制：

- **直播广场 `squarefeed`**：匿名可用，含 `tLiveHostInfo.userId`、`tRoomInfo.roomId` 与 `master_url` 原画流；
- **搜索 `onebox`**：需要登录态，含 `id`（用户 ID）、`red_id`（小红书号）、`live_info.room_id` 与 `flvUrl`；
- **关注/推荐流 `homefeed`**：含 `note.liveCard.live` 与 `note.user.userId`；
- **直播间页面**：从 `__INITIAL_STATE__.liveStream.roomData.hostInfo.userId` 可直接得到主播主页用户 ID（直播间 → 主页 uid），并从 `roomInfo.deeplink` / `pullConfig` 取得流地址。

命中后会向 `POST {baseUrl}/api/notify/live_download` 发送 `url`（流地址）、`title`、`room_url`（`/livestream/{roomId}`）、`host_user_id` 与 `live_room_id`，由后端按稳定目标归并。

## 弹幕采集

扩展通过 `inject.js` 注入快手与小红书直播间页面捕获实时弹幕，经 `content.js` 聚合（每 3 秒一批）转发给 `background.js` 推送至后端：

- **快手（`live.kuaishou.com/u/{id}`）**：拦截 WebSocket 消息（protobuf 二进制 + JSON 双模式）。
- **小红书（`www.xiaohongshu.com/livestream/{roomId}`）**：采用双保险去重采集（RWP WebSocket `wss://apppush-rws.xiaohongshu.com/rwp` 的 `t=4` SYNC 帧 Base64 UTF-8 解码 + 评论区 `.virtual-list-item` DOM `MutationObserver` 兜底，共享 3 秒滑动窗口去重）。支持从首页或个人主页通过 SPA 软路由进入直播间。
- **服务端驱动自动开/关后台标签页**：在 K-Recorder 后端将某直播间开启「浏览器插件弹幕采集」（`rooms.extension_danmaku_enabled = true`）后，扩展会在 SW 启动、每分钟定时轮询及手动「立即检测」时调用 `GET {statusApiUrl}?active=true`：若用户尚未手动打开该直播间，则自动在后台静默打开标签页采集弹幕；当录制结束或关闭该开关时，自动关闭扩展创建的后台标签页。

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
  "caption": "直播描述",
  "cover_url": "直播间封面地址（可选，取自关注列表 poster 字段）"
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

### 立即检测与轮询状态

1. 打开扩展设置页，顶部「关注列表轮询」卡片应显示**轮询间隔 1 分钟**、**下次请求时间**和秒级倒计时，状态徽章为「运行中」。
2. 打开 Popup，点击右下「⚡ 立即检测」。
3. 预期：按钮先变为「⏳ 检测中…」，随后显示「✅ 检测完成」，且「上次请求时间」立即刷新（手动检测不走 2~6 秒随机延迟，应在 1~2 秒内完成）。
4. 回到设置页，倒计时应从接近 1 分钟重新开始 —— 说明 interval 已被取消并重建。
5. 前置条件不满足时按钮会显示具体原因（如未访问过快手、监听已停用、正在录制中），而不是静默无反应。

### Popup 录制状态

Popup 的「监听中」卡片下方会显示两行平台监控摘要（快手关注轮询 / 小红书开播发现，右侧为监控条目数，鼠标悬停可看名单），以及独立的「录制中」卡片：

- 数据来自各启用环境的 `GET /api/notify/status?active=true&include_all=true`，覆盖全部平台。
- 每行显示平台徽章、房间名、环境、录制状态（录制中 / 已暂停）和已录时长；点击可在新标签页打开房间。
- 每 5 秒刷新一次，弹幕采集卡片仍按原 3 秒周期刷新。
