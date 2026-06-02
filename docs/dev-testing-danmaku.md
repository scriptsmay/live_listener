# 开发环境弹幕录制+压制测试指南

本文档说明如何在开发环境下测试直播间 `https://live.kuaishou.com/u/KPL704668133` 的弹幕录制与压制功能。

## 前提条件

在开始之前，需要确保以下条件满足：

1. **本地后端服务已启动**：开发环境默认后端地址为 `http://localhost:3001`，需要确保该服务正在运行，并实现了以下接口：
   - `POST /api/notify/live_download` — 录制触发
   - `GET /api/notify/status?url={roomUrl}` — 录制状态查询，返回 `{ exists: true, data: { status: "recording" | "paused" | ... } }`
   - `POST /api/danmaku/batch` — 弹幕批量接收，请求体为 `{ room_url, events, session_start_ms, title }`

2. **浏览器已登录快手**：在 Chrome 中先访问任意 `kuaishou.com` 页面，确保有有效登录 Cookie。

3. **目标直播间正在直播**：`https://live.kuaishou.com/u/KPL704668133` 需要在直播状态，否则无法捕获直播流和弹幕。

## 步骤一：确认 manifest 权限

`manifest.json` 的 `host_permissions` 中已包含 `http://localhost:3001/*` 和 `http://localhost:*/*`。如果后续新增环境端口，需要同步更新 manifest 并在 `chrome://extensions` 页面重新加载扩展。

## 步骤二：配置开发环境

1. 在 Chrome 扩展管理页找到 Live Stream Sniffer，点击"详情" → "扩展程序选项"。
2. 找到"开发环境"卡片：
   - 勾选"启用"。
   - "服务地址（Base URL）"填写 `http://localhost:3001`。
   - "关注的主播"填写直播间对应的主播名称。主播名称需要与快手关注列表 API 返回的 `author.name` 一致。对于 `KPL704668133`，需要确认该主播在快手显示的名字并填写（例如如果主播显示名为"某某"，则填"某某"）。
3. 如果只想测试开发环境，可以暂时取消"生产环境"的启用。
4. 点击"保存设置"。

## 步骤三：进入直播间测试弹幕采集

1. 打开 `https://live.kuaishou.com/u/KPL704668133`。
2. 打开 Chrome DevTools（F12），切到 Console 面板，观察以下日志序列：

**inject.js 注入阶段**（页面 Console）：
```
[KS-Danmaku] 弹幕拦截脚本已注入 (v3 - protobuf decode)
[KS-Danmaku] WebSocket 构造函数已替换，原型级 hook 已就绪
```

**content.js 转发阶段**（页面 Console）：
```
[Content] 开始注入弹幕拦截脚本...
[Content] inject.js 已注入到页面
[Content] 弹幕拦截脚本已就绪
```

**background.js 会话创建阶段**（Service Worker Console）：
```
[Danmaku] 采集会话已创建（等待录制）: https://live.kuaishou.com/u/KPL704668133
```

3. 等待 WebSocket 消息被拦截。页面 Console 中每 15 秒会输出一次统计：
```
[KS-Danmaku] 统计: 总消息=N (字符串=X, 二进制=Y, 已解码=Z, 跳过小=W), ...
弹幕=M, 礼物=G, 点赞=L
```

如果"弹幕"计数在增长，说明弹幕拦截正常工作。

## 步骤四：测试录制状态感知（压制机制）

弹幕的发送严格跟随后端录制状态，未录制时仅缓冲不发送——这就是"压制"。

### 测试"未录制 → 缓冲"

1. 确保后端 `/api/notify/status` 接口对该直播间返回"未录制"（即 `exists: false` 或 `status` 不是 `recording`/`paused`）。
2. 在 Service Worker Console 中，应看到会话创建后检查录制状态，但没有"开始发送弹幕"的日志。
3. 此时弹幕被采集并缓冲在内存中（上限 5000 条），不会发送到后端。

### 测试"录制开始 → 开启发送"

1. 通过后端触发录制（或在 Popup 中点击"开始录制"按钮），使 `/api/notify/status` 返回 `status: "recording"`。
2. 在 10 秒内（轮询周期），Service Worker Console 应出现：
```
[Danmaku] 录制中，开始发送弹幕: https://live.kuaishou.com/u/KPL704668133
```
3. 之后每 5 秒，后端 `/api/danmaku/batch` 接口应收到一批弹幕事件。请求体格式：
```json
{
  "room_url": "https://live.kuaishou.com/u/KPL704668133",
  "events": [
    { "ts_ms": 12345, "ts_abs_ms": 1717000000000, "type": "comment", "user": "用户A", "userId": "xxx", "text": "666" },
    { "ts_ms": 12400, "ts_abs_ms": 1717000000055, "type": "gift", "user": "用户B", "userId": "yyy", "giftName": "小心心", "count": 1 }
  ],
  "session_start_ms": 1716999987655,
  "title": "直播间标题"
}
```

### 测试"录制结束 → 停止发送"

1. 在后端停止录制，使 `/api/notify/status` 返回非 `recording`/`paused` 状态。
2. 在 10 秒内，Service Worker Console 应出现：
```
[Danmaku] 录制已结束，停止发送弹幕: https://live.kuaishou.com/u/KPL704668133
```
3. 后端应先收到最后一批 flush 的弹幕（剩余缓冲），之后不再收到新的弹幕请求。

## 步骤五：在 Popup 中手动触发录制

如果后端未自动录制，也可以通过 Popup 手动触发：

1. 点击 Chrome 工具栏上的 Live Stream Sniffer 图标打开 Popup。
2. 在检测到的直播流列表中找到 KPL704668133 的直播间。
3. 点击"开始录制"按钮。
4. 按钮变为"已发送"后，弹幕发送通道应在 10 秒内自动开启。

## 步骤六：通过 Popup 弹幕状态面板观察采集

Popup 右侧下方的"弹幕采集状态"面板每 3 秒自动刷新，是观察弹幕采集是否正常的最直观方式：

1. 打开 Popup，查看右侧"弹幕采集状态"卡片。
2. 如果直播间已打开且弹幕脚本注入成功，应看到一个会话条目，显示房间名和状态徽章。
3. 状态含义：
   - **采集中**（绿色）：`isSending=true`，弹幕正在向后端发送。统计行显示已采集事件数、缓冲条数、运行时长。
   - **等待录制**（橙色）：弹幕会话已创建但后端尚未开始录制，弹幕在缓冲中等待。
   - **已停止**（红色）：会话正在关闭。
4. 如果状态为"采集中"但已采集条数为 0，面板会显示橙色引导提示"点击打开直播间检查弹幕是否正常加载"——点击后跳转到直播间标签页。

## 步骤七：测试自动标签页行为

当后台轮询检测到开播并成功推送录制请求后，扩展会自动在后台打开直播间标签页用于弹幕采集：

1. 确保关注的主播正在直播，且后端录制请求返回成功（200）。
2. 在 Service Worker Console 中应看到：
```
[Danmaku] 自动打开后台标签页: https://live.kuaishou.com/u/xxx (tabId=N)
```
3. 浏览器标签栏中会出现一个新的后台标签页（不会自动切换过去）。
4. 该标签页加载完成后，弹幕采集脚本自动注入，弹幕开始采集。
5. 在 Popup 弹幕状态面板中，应看到该房间显示"采集中"且"后台标签页已打开"。
6. 当后端录制结束后，Service Worker Console 应出现：
```
[Danmaku] 录制结束，已关闭自动标签页: https://live.kuaishou.com/u/xxx (tabId=N)
```
7. 后台标签页自动关闭。

## 步骤八：测试录制拒绝场景

当后端返回非 2xx 响应（如 400 "暂停监听"）时：

1. Service Worker Console 应输出：
```
[Live Stream Sniffer][development] 录制被拒绝: 直播间 xxx 已暂停监听
```
2. 不会自动打开后台标签页。
3. Popup 中该直播间的"开始录制"按钮不会被标记为"录制中"（如果有旧标记会被自动清除）。
4. 如果之前有弹幕会话处于发送状态，会被回退到缓冲模式：
```
[Danmaku] 录制被拒绝，停止弹幕发送: https://live.kuaishou.com/u/xxx
```

## 排查要点

**弹幕采集不到**：
- 检查页面 Console 是否有 `[KS-Danmaku]` 开头的日志，确认 inject.js 注入成功。
- 如果统计中"总消息"为 0，可能是 WebSocket 连接未建立或已被页面用其他方式处理。尝试刷新页面。
- 如果统计中"已解码"有值但"弹幕"为 0，可能是 PayloadType 不匹配或评论结构变化。

**录制状态不联动**：
- 在 Service Worker Console 中手动检查：打开 `chrome://extensions`，点击 Service Worker 的"检查视图"。
- 确认后端 `/api/notify/status` 接口返回的格式正确（`{ exists: true, data: { status: "recording" } }`）。
- 注意检查后端返回的是 HTTP 200，且 `exists` 为 `true`。

**弹幕发送不到后端**：
- 检查 Service Worker Console 是否有 `[Danmaku] 批量发送失败` 的警告。
- 确认 `http://localhost:3001` 在 manifest `host_permissions` 中已声明。
- 确认后端 `/api/danmaku/batch` 接口可正常访问。

**Options 页面无法保存开发环境地址**：
- 说明该地址未在 manifest `host_permissions` 中声明，需要按步骤一修改 manifest。

## 完整的数据流示意

```
关注列表轮询 / webRequest / content.js
       │
       ▼
  sendToEnvironments()
  ├─ 录制请求成功 (2xx)
  │   ├─ setActiveRecordingRoom()
  │   ├─ activateDanmakuForRoom() → isSending=true
  │   └─ ensureDanmakuTab() → chrome.tabs.create({ active: false })
  │
  └─ 录制被拒绝 (非 2xx)
      ├─ 日志输出拒绝原因
      ├─ deactivateDanmakuForRoom() → isSending=false（回退缓冲）
      ├─ closeAutoOpenedTab() → 关闭自动标签页
      └─ recording_rejected 消息 → Popup 清除过期"录制中"标记

自动标签页加载后：
  快手直播间 WebSocket
       │
       ▼
  inject.js (MAIN world)
  ├─ Hook WebSocket.prototype.addEventListener
  ├─ Hook WebSocket.prototype.onmessage
  ├─ Protobuf 解码 / JSON 解析
  ├─ 提取 comment / gift / like 事件
  │
  │  window.postMessage({ source: 'ks-danmaku-inject', type: 'danmaku_events', events })
  ▼
  content.js (ISOLATED world)
  ├─ 接收 postMessage
  ├─ 缓冲区 danmakuBuffer[]
  ├─ 每 5 秒 flush → chrome.runtime.sendMessage({ Message: 'danmakuBatch' })
  │
  ▼
  background.js (Service Worker)
  ├─ danmakuSessions Map（会话管理）
  ├─ danmakuBatchBuffer Map（事件缓冲）
  ├─ autoOpenedTabs Map（自动标签页追踪）
  ├─ checkRecordingAndUpdateSession()（每 10 秒检查录制状态）
  │   ├─ 录制中 → isSending=true → 开启发送
  │   └─ 未录制 → flush 剩余 → isSending=false → closeAutoOpenedTab()
  ├─ flushDanmakuBatch()（每 5 秒）
  │   ├─ isSending=false → 跳过（保留缓冲）
  │   └─ isSending=true → 标准化 → 过滤 → POST /api/danmaku/batch
  │
  ├─ Popup get_danmaku_status 查询（每 3 秒）
  │   └─ 返回所有活跃会话的状态、统计、引导信息
  │
  ▼
  后端 (localhost:3001)
  └─ 接收 { room_url, events, session_start_ms, title }
```
