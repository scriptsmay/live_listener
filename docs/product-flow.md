# Live Stream Sniffer 产品流程文档

## 产品概述

Live Stream Sniffer 是一个 Manifest V3 Chrome 扩展，用于监测快手直播流并推送到本地录制后端。它同时具备弹幕采集能力，能够拦截直播间 WebSocket 消息，提取弹幕（评论、礼物、点赞），并与后端录制状态联动——仅在录制期间向后端发送弹幕数据。

## 架构概览

扩展由六个核心模块组成，无构建流程，全部使用原生 ES Module：

**background.js（Service Worker）** 是扩展的中枢，负责直播流检测、录制推送、弹幕会话管理和后端状态轮询。它以 ESM 模式运行（`type: "module"`），使用 `chrome.alarms` 驱动周期性任务。

**content.js（Content Script）** 注入到 `live.kuaishou.com` 页面，承担三项职责：检测 `<video>` 标签的 `currentSrc` 补充捕获直播流、将 `inject.js` 注入到页面 MAIN world、以及作为弹幕事件从 MAIN world 到 Service Worker 的中继桥梁。

**inject.js（MAIN world 注入脚本）** 通过原型级 Hook 拦截页面 WebSocket 通信，同时支持 Protobuf 二进制和 JSON 双模式解码，提取评论、礼物、点赞等弹幕事件。

**danmaku-parser.js（弹幕解析器）** 提供标准化工具函数，将原始弹幕事件统一为后端可存储的格式，并支持过滤（屏蔽词、主播名、事件类型）。

**config.js（配置管理）** 管理多环境配置，包括后端地址、关注主播列表和清晰度权重。支持 `chrome.storage.sync` 持久化和旧版配置兼容。

**popup.js / options.js（用户界面）** Popup 用于展示检测到的直播流和手动触发录制；Options 用于配置每个环境的后端地址和关注主播。

## 多环境配置体系

扩展支持多个后端环境并行工作，每个环境独立配置：

**生产环境**默认指向 `http://192.168.31.247:11123`，默认启用，关注主播列表默认为 `['KSG无言']`。

**开发环境**默认指向 `http://localhost:3001`，默认禁用，关注主播列表默认为空。

每个环境有三个后端接口，接口后缀由扩展固定拼接：录制接口 `POST {baseUrl}/api/notify/live_download`、状态接口 `GET {baseUrl}/api/notify/status?url={roomUrl}`、弹幕接口 `POST {baseUrl}/api/danmaku/batch`。

关注主播列表下沉到每个环境独立配置，不再全局共享。同一主播可以被多个环境关注，录制请求会分别发送给匹配的环境后端。

## 直播流检测流程

扩展通过三条链路检测直播流，覆盖自动轮询和被动捕获两种场景。

### 链路一：关注开播轮询（主动检测）

这是最核心的自动录制链路。Service Worker 启动时创建 `chrome.alarms` 定时器，每 1 分钟执行一次 `checkFollowingLivings()`。

执行流程如下：首先检查 `monitorEnabled` 开关（Popup 中可切换），未启用则跳过。然后检查 `activeRecordingRoomUrl`，如果存在且任一启用环境确认仍在录制中，则跳过本次查询以减少快手 API 风控风险。接下来检查是否访问过快手页面（有 Cookie 才能调 API），以及所有启用环境的关注主播合集是否为空。

满足前提条件后，加入 2-6 秒随机延迟（防风控），然后请求快手关注开播接口 `https://live.kuaishou.com/live_api/follow/living`。拿到开播列表后，遍历每个主播，找出关注该主播的启用环境，触发 `handleStreamerOnline()`。

`handleStreamerOnline()` 优先从快手 API 返回的 `playUrls` 中选取最高画质的 FLV 地址，直接推送给匹配环境的后端。如果 API 未返回流地址，则通过 `ensureDanmakuTab()` 自动打开直播间后台标签页，让 webRequest 链路捕获流地址的同时启动弹幕采集。同时创建 Chrome 桌面通知，点击可跳转到直播间。

### 链路二：webRequest 捕获（被动检测）

`chrome.webRequest.onBeforeRequest` 监听所有网络请求，当发现包含 `.flv` 的请求时，获取关联标签页的信息。如果标签页 URL 是快手直播间（`live.kuaishou.com/u/...`），则将其加入已检测流列表。

然后按页面标题匹配各环境的关注主播列表（`tab.title.includes(authorName)`），匹配到的环境会进入 `autoChooseBest()` 清晰度选择流程。该流程使用 `QUALITY_WEIGHTS` 权重表评估画质（4K=120, 1080p8M=100, ...），以 2 秒 debounce 等待所有候选清晰度出现，最终选择最高画质的流地址推送给匹配环境。

### 链路三：content.js video 检测（补充捕获）

content.js 每 3 秒检查页面中 `<video>` 标签的 `currentSrc`，捕获 webRequest 可能遗漏的流地址（比如动态加载的流）。检测到的流地址通过 `chrome.runtime.sendMessage` 发给 Service Worker，同样按页面标题匹配环境并推送。这条链路同时起到 MV3 Service Worker 保活的作用。

## 弹幕采集流程

### 注入与拦截

当用户进入快手直播间页面时，content.js 在 `document_start` 阶段将 inject.js 注入到页面 MAIN world。inject.js 通过两个原型级 Hook 拦截 WebSocket 消息：

Hook 1 替换 `EventTarget.prototype.addEventListener`，捕获所有对 WebSocket 实例注册的 `message` 事件监听器，在原始 handler 被调用前先处理消息。

Hook 2 重写 `WebSocket.prototype.onmessage` 的 setter，拦截 `ws.onmessage = handler` 赋值，同样在原始 handler 前插入处理逻辑。

此外还 patch 了 WebSocket 构造函数，追踪快手相关的 WebSocket 实例用于调试。

### 消息解码

inject.js 同时支持两种消息格式。对于二进制消息（ArrayBuffer/Blob），使用自实现的 Protobuf 线格式解码器逐字段解析，支持 varint、length-delimited（字符串/嵌套消息/原始字节）、32-bit 和 64-bit 等 wire type，最多递归 8 层。对于字符串消息，尝试 JSON 解析作为降级兼容。

已知的 Protobuf PayloadType 包括：`FEED_PUSH (310)` 包含评论列表（field 5）和礼物列表（field 8），`COMMENT_RICH_TEXT (829)` 包含富文本评论。解码器会从嵌套消息中智能提取用户名（排除头像 URL、userId 等干扰项），并通过 `isRealText()` 过滤器排除 base64、URL、内部标识符等非真实文本。

### 数据中继

inject.js 提取到弹幕事件后，通过 `window.postMessage` 发送给 content.js（ISOLATED world）。content.js 将事件缓冲在 `danmakuBuffer[]` 中，每 5 秒通过 `chrome.runtime.sendMessage` 批量发送给 background.js。

页面卸载时（`beforeunload`），content.js 会 flush 剩余缓冲并发送 `danmakuStop` 通知 Service Worker 清理会话。

### 会话管理与录制状态感知（压制机制）

background.js 中维护两个核心 Map：`danmakuSessions`（会话状态）和 `danmakuBatchBuffer`（事件缓冲）。

**会话创建**：收到 `danmakuReady` 消息时调用 `startDanmakuSession()`，创建会话但 `isSending=false`，进入缓冲模式——采集弹幕但不发送。

**录制激活（主动通知）**：当 `sendToEnvironments()` 成功发出录制请求，或查询后端状态确认已在录制中时，会立即执行两步操作：调用 `activateDanmakuForRoom(roomUrl)` 将该房间弹幕会话的 `isSending` 置为 `true`，消除录制确认到弹幕发送之间的轮询等待；同时调用 `ensureDanmakuTab(roomUrl)` 在后台打开一个不激活的标签页到直播间，确保 content.js 和 inject.js 能够注入并启动弹幕采集。这样即使后台轮询检测到开播时用户并未打开直播间页面，弹幕采集也能自动运行。

**录制拒绝处理**：当后端返回非 2xx 响应（如 400 "暂停监听"）时，`sendToEnvironments()` 会记录拒绝原因日志，调用 `deactivateDanmakuForRoom(roomUrl)` 将弹幕会话回退到缓冲模式（`isSending=false`），调用 `closeAutoOpenedTab(roomUrl)` 关闭可能已自动打开的后台标签页，并通过 `recording_rejected` 消息通知 Popup 清除该直播间过期的"录制中"按钮标记，确保界面状态与后端实际保持一致。

**自动标签页管理**：`ensureDanmakuTab()` 通过 `chrome.tabs.create({ active: false })` 创建后台标签页，并在 `autoOpenedTabs` Map 中记录 roomUrl 到 tabId 的映射。如果该房间已有打开的标签页（用户手动打开或之前自动创建且仍存在），不会重复创建。录制结束后，`closeAutoOpenedTab()` 会关闭扩展自动打开的标签页——用户手动打开的标签页不受影响。

**录制状态轮询（兜底机制）**：`checkRecordingAndUpdateSession()` 遍历所有启用环境，查询各自的 `/api/notify/status` 接口，用于处理后端侧状态变化（如后端异常中断、外部触发的录制结束等主动通知无法覆盖的场景）。如果任一环境返回 `status: "recording"` 或 `"paused"`，则：
- 从未发送切换到发送：`isSending=true`，后续 flush 开始实际发送弹幕。
- 从发送切换到未发送：先 flush 剩余缓冲，再 `isSending=false`，后续 flush 只缓冲不发送。同时调用 `closeAutoOpenedTab()` 关闭自动打开的后台标签页。

触发时机包括：`danmakuReady` 立即检查、定时器每 10 秒周期检查、`danmakuBatch` 自动创建时检查。

**批量发送**：`flushDanmakuBatch()` 每 5 秒由定时器触发。如果 `isSending=false`，直接跳过（保留缓冲数据）。如果 `isSending=true`，从缓冲区取出所有事件，经 `normalizeDanmakuBatch()` 标准化（统一字段、计算相对时间戳），再经 `filterDanmakuEvents()` 过滤（当前默认排除点赞），最后 POST 到所有启用环境的 `/api/danmaku/batch` 接口。

**缓冲区保护**：缓冲区上限 5000 条事件，超出时丢弃最早的事件，防止长时间不录制期间内存泄漏。

**会话清理**：`stopDanmakuSession()` 使用 `stopping` 标记阻止新事件进入缓冲，同步取出剩余缓冲，如有 `forceFlush` 则发送最后一批数据，最终从 Map 中移除会话。

## Popup 界面

Popup 分为左侧直播流列表和右侧状态面板。

左侧展示已检测到的直播流，每条显示标题、画质标签、直播间地址、捕获时间和"开始录制"按钮。手动录制会推送到所有启用环境，推送前先查询状态避免重复发送。"清空列表"按钮可清除所有检测记录。

右侧上方展示后台监听关注列表的开关状态、上次请求时间和结果。开关控制 `monitorEnabled`，切换时通知 Service Worker 重新检测。

右侧下方是弹幕采集状态面板，每 3 秒自动刷新，展示所有活跃的弹幕会话。每个会话显示三种状态之一：**采集中**（绿色，`isSending=true`，弹幕正在向后端发送）、**等待录制**（橙色，会话已创建但录制尚未开始，弹幕在缓冲中）、**已停止**（红色，会话正在关闭）。统计行显示已采集事件数、缓冲区大小、运行时长和后台标签页状态。当会话处于发送状态但已采集事件数为零时，面板会显示引导提示，点击可跳转到对应直播间排查采集脚本是否正常工作。当后端拒绝录制时，Popup 通过 `recording_rejected` 消息自动清除该直播间过期的"录制中"按钮标记。

## Options 设置

Options 页面渲染每个环境的独立配置卡片，包含启用开关、Base URL 输入框和关注主播 textarea。保存时验证 Base URL 格式（必须是 http/https）和 manifest 权限声明，通过后写入 `chrome.storage.sync`，并通知 Service Worker 重新检测。

## 录制优化策略

**全局单直播间暂停轮询**：当 `activeRecordingRoomUrl` 存在且后端确认仍在录制中时，跳过整次快手关注列表查询，减少平台 API 请求频率，降低风控风险。

**清晰度选择 debounce**：webRequest 可能在短时间内捕获同一场直播的多个清晰度流。`autoChooseBest()` 按 `roomUrl` 隔离状态，等 2 秒后选出最高画质，避免重复推送。

**随机延迟**：每次查询快手关注列表前加入 2-6 秒随机延迟，避免请求时间过于固定被风控识别。

## 状态持久化

**chrome.storage.sync** 存储用户配置：环境列表（含 baseUrl、enabled、followedAuthors）和全局 monitorEnabled 开关。

**chrome.storage.local** 存储运行时状态：已检测流列表 `streams`（最多 100 条）、已通知过的直播间 `notifiedRooms`、当前录制中的直播间 `activeRecordingRoomUrl`、上次关注列表请求结果 `lastReqStatus`。

Service Worker 启动时从 local storage 恢复 `streams`、`notifiedRooms` 和 `activeRecordingRoomUrl`，确保 MV3 Service Worker 重启后关键状态不丢失。

## 后端接口协议

### 录制触发

请求：`POST {baseUrl}/api/notify/live_download`

```json
{
  "url": "FLV 直播流地址",
  "title": "直播间标题或主播名",
  "room_url": "https://live.kuaishou.com/u/xxx",
  "caption": "直播描述"
}
```

### 录制状态查询

请求：`GET {baseUrl}/api/notify/status?url={roomUrl}`

响应：
```json
{
  "exists": true,
  "data": {
    "status": "recording"
  }
}
```

`status` 为 `recording` 或 `paused` 时，扩展认为该环境正在录制。

### 弹幕批量推送

请求：`POST {baseUrl}/api/danmaku/batch`

```json
{
  "room_url": "https://live.kuaishou.com/u/xxx",
  "events": [
    {
      "ts_ms": 12345,
      "ts_abs_ms": 1717000000000,
      "type": "comment",
      "user": "用户名",
      "userId": "用户ID",
      "text": "弹幕内容"
    },
    {
      "ts_ms": 12400,
      "ts_abs_ms": 1717000000055,
      "type": "gift",
      "user": "用户名",
      "userId": "用户ID",
      "giftName": "礼物名称",
      "giftId": "",
      "count": 1
    }
  ],
  "session_start_ms": 1716999987655,
  "title": "直播间标题"
}
```

其中 `ts_ms` 是相对于会话开始的毫秒数，`ts_abs_ms` 是绝对时间戳。
