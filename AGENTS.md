# Live Stream Sniffer — Chrome Extension

## Setup

No build, no bundler, no package manager. Load as unpacked extension in `chrome://extensions` (dev mode). After editing any JS/HTML file, reload the extension on that page.

## Architecture

- **Manifest V3** — service worker (`background.js`) is ESM (`type: "module"`).
- All files are plain ES modules that `import` from each other directly. No build step.
- `background.js` 是纯胶水层（~30 行），仅负责导入模块、恢复状态、注册监听器。所有业务逻辑分布在 `core/` 模块中。

### 目录结构

```
background.js                  # Service Worker 入口（纯胶水）
core/                          # 核心业务逻辑
  state.js                     # 统一状态仓库（集中管理所有运行时状态 + 原子持久化）
  event-bus.js                 # 事件总线（模块间解耦通信）
  message-router.js            # 消息路由（chrome.runtime.onMessage 唯一入口）
  config.js                    # 环境配置 + getConfig()
  stream-detector.js           # 直播流检测、去重、画质选择延迟
  stream-quality.js            # 清晰度权重/标签（平台相关业务逻辑）
  recording.js                 # 录制请求推送、状态查询、录制拒绝处理
  danmaku-session.js           # 弹幕会话管理、批量发送
  danmaku-switch.js            # 弹幕采集开关
  following-poll.js            # 关注列表轮询、开播检测
lib/                           # 公共工具层（纯工具，无业务逻辑）
  http.js                      # fetchJson 统一封装
  url.js                       # isKuaishouLiveRoomUrl、getLiveRoomUrlFromRequest
  constants.js                 # 消息 action 名 (ACTIONS)、storage key (STORAGE_KEYS)
  logger.js                    # 统一日志封装（支持 debug 开关）
content/                       # 内容脚本
  content.js                   # 视频嗅探 + 弹幕聚合（前端 3s buffer）+ 转发中继
  inject.js                    # MAIN world WebSocket hook（IIFE，不可用 ESM）
danmaku/                       # 弹幕解析
  parser.js                    # 标准化 + 过滤
ui/                            # 用户界面
  popup.html / popup.js / popup.css
  options.html / options.js / options.css
```

### Entrypoints

- `background.js` — service worker 入口
- `content/content.js` — 注入到 `live.kuaishou.com`（ISOLATED world，不可用 ESM）
- `content/inject.js` — 注入到 MAIN world（IIFE，不可用 ESM）
- `ui/popup.js` — popup UI（ESM）
- `ui/options.js` — 设置页面（ESM）

### 模块通信

模块间通过 `core/event-bus.js` 解耦通信。`stream-detector` 检测到流后发射 `EVENTS.STREAM_DETECTED`，`recording.js` 监听该事件触发录制推送。新增功能（通知、统计、Webhook）只需添加监听器，不修改已有模块。

### 状态管理

所有运行时状态集中在 `core/state.js`，通过 getter/setter 访问。涉及"读取-变更-写入"的持久化操作必须通过原子接口（`atomicAppendStream`、`persistNotifiedRooms` 等）执行，内部使用 Promise 链锁防止并发写入覆盖。`restoreState()` 在 Service Worker 启动时从 `chrome.storage` 恢复全部状态。

### 消息协议

所有跨模块消息统一为 `{ action: '...' }` 格式（snake_case），常量定义在 `lib/constants.js` 的 `ACTIONS` 对象中。`core/message-router.js` 同时兼容旧的 `{ Message: '...' }` 格式以确保过渡期安全。

### 存储

- User settings（环境配置、弹幕开关、监控开关）→ `chrome.storage.sync`
- Detected streams、notified rooms、active recording → `chrome.storage.local`

## Key constraints

- `host_permissions` limit to `*.kuaishou.com`, `*.yximgs.com`, `localhost:*/*`, `192.168.31.247:*/*`.
- `content_scripts` 的 `matches` 严格限制在 `*://live.kuaishou.com/*`，`web_accessible_resources` 中 `inject.js` 的 `matches` 同样限制在该域名。
- `content/content.js` 和 `content/inject.js` 不支持 ESM（manifest content_scripts 不支持 `type: module`，MAIN world 不支持 `import`）。`content.js` 中的 `isLiveRoomPage()` 直接内联（仅 4 行）。
- Auto-record triggers only when tab title matches an environment's `followedAuthors` list（`core/stream-detector.js`）。
- Two sources of stream URL detection:
  - `chrome.webRequest` captures `.flv` URLs; quality selection via `QUALITY_WEIGHTS` with 2-second debounce (`core/stream-detector.js`).
  - `content/content.js` reads `<video>.currentSrc` every 3 seconds (also acts as MV3 SW keepalive). Handled via `core/message-router.js`.
- Recording-aware polling: when recording is confirmed, sets `activeRecordingRoomUrl` via `core/state.js`; subsequent `checkFollowingLivings` ticks query backend `/status` first and skip Kuaishou API if still recording (`core/following-poll.js`).
- Backend endpoints (configurable in settings):
  - `POST {notifyApiUrl}` with JSON body `{ url, title, room_url, caption }` — start recording.
  - `GET {statusApiUrl}?url={roomUrl}` — check if already recording.
  - `POST {danmakuBatchApiUrl}` with JSON body `{ room_url, events, session_start_ms, title }` — push danmaku batch.
- `core/config.js` defines multiple environments (`production` → `:11123`, `development` → `:3001`).
  - Each environment has its own toggle, notify API URL, and status API URL.
  - When `sendToEnvironments` is called, it loops through all **enabled** environments and sends requests to each.
  - Author list is per-environment (`followedAuthors`).
- `getConfig()` returns `{ environments: [...], followedAuthors: [...] }`.
- **MV3 Service Worker 生命周期**：所有关键状态必须视为可丢失状态。SW 空闲 ~30s 后可能被销毁，重启时内存变量全部重置。`setInterval` 不可靠，必须用 `chrome.alarms` 替代（`core/following-poll.js`）。`Map`/`Set` 不可靠——必须确保关键状态已持久化且 `restoreState()` 能完整重建。

## Danmaku architecture

**数据流**：`inject.js` (MAIN world, WebSocket hook) → `content.js` (ISOLATED world, postMessage relay, **3s 前端聚合**) → `background.js` (service worker, **收到即转发，无秒级定时器**) → 后端 `POST /api/danmaku/batch`

**前端聚合策略**（规避 MV3 SW 休眠）：弹幕聚合由 `content/content.js`（依托于网页端，天然不会休眠）完成，每 3 秒通过 `ACTIONS.DANMAKU_BATCH` 批量发送给 Background。Background 收到后直接通过 `core/danmaku-session.js` 的 `handleDanmakuBatch()` 转发给后端，不维护任何秒级定时器，彻底规避 SW 休眠导致定时器失效的问题。

**录制状态感知**（`core/danmaku-session.js`）：弹幕发送严格跟随后端录制状态，未录制时仅缓冲不发送。

- `danmakuSessions` Map 中每个会话有 `isSending` 和 `stopping` 标记
- `startDanmakuSession()` 创建会话时 `isSending=false`（缓冲模式）
- `checkRecordingAndUpdateSession(roomUrl)` 查询后端录制状态并自动启停：
  - 录制开始 → `isSending=true`，开启发送
  - 录制结束 → 先 flush 剩余缓冲，再 `isSending=false`
- 触发时机：`danmaku_ready` 立即检查 + `danmaku_batch` 自动创建时检查 + `handleDanmakuBatch` 每次收到批次时立即 flush
- `flushDanmakuBatch()` 检查 `isSending`，为 false 时跳过发送（保留缓冲）
- 缓冲区上限 5000 条事件，超出丢弃最早事件（防止长时间不录制时内存泄漏）
- `stopDanmakuSession(roomUrl, forceFlush)` 使用 `stopping` 标记 + 同步 drain 防止竞态

**循环依赖处理**：`danmaku-session.js` 与 `danmaku-switch.js`、`recording.js` 之间存在互调关系。通过在 `danmaku-session.js` 中使用动态 `import()` 延迟加载来打破循环。

## Testing

No test framework exists. Manual testing only: load extension, navigate to `live.kuaishou.com`, verify badge count and popup.

## Style

Plain JavaScript, no TypeScript, no formatter. Imports use full `.js` extensions. All comments and strings are in Chinese. 新增消息类型时必须使用 `lib/constants.js` 中的 `ACTIONS` 常量，禁止硬编码 action 字符串。新增运行时状态必须放入 `core/state.js`，禁止在各业务模块中持有局部状态变量。
