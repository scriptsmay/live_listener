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
  following-poll.js            # 关注列表轮询、开播检测、手动立即检测
  poll-schedule.js             # 轮询 alarm 的创建/查询/清除（可被 options 页依赖）
  xhs-live-discovery.js        # 小红书页面直播信息发现 → 匹配监控主播 → 录制上报
  xhs-authors.js               # 小红书监控条目解析（小红书号 / 用户ID / 主页链接 / 昵称）与匹配
lib/                           # 公共工具层（纯工具，无业务逻辑）
  http.js                      # fetchJson 统一封装
  url.js                       # isKuaishouLiveRoomUrl、isXiaohongshuLiveRoomUrl、isSupportedLiveRoomUrl、normalizeRoomUrl、getLiveRoomUrlFromRequest
  constants.js                 # 消息 action 名 (ACTIONS)、storage key (STORAGE_KEYS)
  logger.js                    # 统一日志封装（支持 debug 开关）
content/                       # 内容脚本
  content.js                   # 视频嗅探 + SPA 路由监听 + 弹幕聚合（前端 3s buffer）+ 转发中继
  inject.js                    # MAIN world WebSocket hook + 小红书 RWP/DOM 弹幕采集（IIFE，不可用 ESM）
danmaku/                       # 弹幕解析
  parser.js                    # 标准化 + 过滤 + 小红书 RWP 帧解析 helper
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

- `host_permissions` limit to `*.kuaishou.com`, `*.yximgs.com`, `*.xiaohongshu.com`, `*.xhscdn.com`, `*.redelight.cn`, `localhost:*/*`, `192.168.31.247:*/*`.
- `content_scripts` 的 `matches` 限制在 `*://live.kuaishou.com/*`、`*://*.xiaohongshu.com/*`、`*://*.redelight.cn/*`，`web_accessible_resources` 中 `inject.js` 的 `matches` 同样限制在上述域名。小红书在全站入口（`pc_index.js`）创建并跨路由复用单一 RWP WebSocket，因此 `content.js` 在小红书域名 `document_start` 阶段即注入 `inject.js`。
- `content/content.js` 和 `content/inject.js` 不支持 ESM（manifest content_scripts 不支持 `type: module`，MAIN world 不支持 `import`）。`content.js` 中的 `isLiveRoomPage()` 与 `normalizeUrlForCompare()` 直接内联。
- Auto-record triggers only when tab title matches an environment's `followedAuthors` list（`core/stream-detector.js`）。
- Two sources of stream URL detection:
  - `chrome.webRequest` captures `.flv` URLs; quality selection via `QUALITY_WEIGHTS` with 2-second debounce (`core/stream-detector.js`).
  - `content/content.js` reads `<video>.currentSrc` every 3 seconds (also acts as MV3 SW keepalive). Handled via `core/message-router.js`.
- Recording-aware polling: when recording is confirmed, sets `activeRecordingRoomUrl` via `core/state.js`; subsequent `checkFollowingLivings` ticks query backend `/status` first and skip Kuaishou API if still recording (`core/following-poll.js`).
- Backend endpoints (configurable in settings):
  - `POST {notifyApiUrl}` with JSON body `{ url, title, room_url, caption, cover_url? }` — start recording. `cover_url` 仅在关注列表轮询链路可用：取快手 `follow/living` 返回的 `poster` 字段；其他链路（webRequest / 手动录制）不带该字段，由后端自行兜底。
  - `GET {statusApiUrl}?url={roomUrl}` — check if already recording (and whether `extension_danmaku_enabled` is enabled).
  - `GET {statusApiUrl}?active=true` — fetch active recording rooms (`kuaishou` / `xiaohongshu`) with `extension_danmaku_enabled = true` so `syncBackendActiveRecordings()` can automatically open/close background danmaku tabs.
  - `GET {statusApiUrl}?active=true&include_all=true` — Popup「录制中」卡片使用，返回全部平台的活跃录制（不要求 `extension_danmaku_enabled`）。只读展示，不要把它用于弹幕同步决策。
  - `POST {danmakuBatchApiUrl}` with JSON body `{ room_url, events, session_start_ms, title }` — push danmaku batch.
- `core/config.js` defines multiple environments (`production` → `:11123`, `development` → `:3001`).
  - Each environment has its own toggle, notify API URL, and status API URL.
  - When `sendToEnvironments` is called, it loops through all **enabled** environments and sends requests to each.
  - Author list is per-environment (`followedAuthors`).
- `getConfig()` returns `{ environments: [...], followedAuthors: [...] }`.
- **MV3 Service Worker 生命周期**：所有关键状态必须视为可丢失状态。SW 空闲 ~30s 后可能被销毁，重启时内存变量全部重置。`setInterval` 不可靠，必须用 `chrome.alarms` 替代（`core/following-poll.js`）。`Map`/`Set` 不可靠——必须确保关键状态已持久化且 `restoreState()` 能完整重建。
- **MV3 alarm 必须每次 SW 启动重建**：`chrome.alarms.create()` 必须在 `initAlarms()` 顶层无条件执行，不能仅放在 `chrome.runtime.onInstalled` 回调里。`onInstalled` 只在首次安装/更新/Chrome 升级时触发，alarm 因任何边界条件（清缓存、扩展被禁用再启用、SW 异常）丢失后不会自愈，表现为"开关正常但不再轮询"的不可见故障。`chrome.alarms.create` 对同名 alarm 是幂等的，重复调用安全。详见 `decisions/adr-002-mv3-alarm-self-healing.md`（知识库镜像路径 `01-Projects/01-Active/chrome-live-listener/decisions/adr-002-mv3-alarm-self-healing.md`）。
- **轮询 alarm 名称与周期只在 `core/poll-schedule.js` 和 `lib/constants.js`（`POLL_ALARM_NAME`）定义**：重新 `create` 同名 alarm 会重置 `scheduledTime`，这是 Popup「立即检测」实现"取消 interval → 立刻查 → 重新计时"的手段。不要在其它模块里散写 `'pollFollowingLivings'` 字面量或用别的周期重建它。
- **UI 页面不要 import `following-poll.js`**：它的依赖链会连带求值 `recording.js` / `danmaku-session.js`，这些模块在顶层就注册 `chrome.alarms` 监听器，在 options/popup 上下文里会凭空跑起来。只读的调度信息一律通过 `ACTIONS.GET_POLL_SCHEDULE` 消息取。
- **`checkFollowingLivings()` 有全局串行守卫 `_checkInFlight`**：alarm 触发、`TOGGLE_MONITOR`、`RECHECK_FOLLOWING`、`CHECK_NOW` 共用它。已有查询在跑时后续调用复用同一 Promise 的结果（返回 `coalesced: true`），绝不并发打快手接口。返回值形如 `{ ran, reason?, onlineAuthors? }`，`ran: false` 表示前置条件不满足而未真正请求，调用方据此向用户展示原因，不要吞掉。

## Danmaku architecture

**数据流**：`inject.js` (MAIN world, WebSocket hook) → `content.js` (ISOLATED world, postMessage relay, **3s 前端聚合**) → `background.js` (service worker, **收到即转发，无秒级定时器**) → 后端 `POST /api/danmaku/batch`

**前端聚合策略**（规避 MV3 SW 休眠）：弹幕聚合由 `content/content.js`（依托于网页端，天然不会休眠）完成，每 3 秒通过 `ACTIONS.DANMAKU_BATCH` 批量发送给 Background。Background 收到后直接通过 `core/danmaku-session.js` 的 `handleDanmakuBatch()` 转发给后端，不维护任何秒级定时器，彻底规避 SW 休眠导致定时器失效的问题。

**小红书双通道采集（`content/inject.js`）**：

- **主通道 RWP WebSocket**：`msg.t === 4` SYNC 帧的 `b.d.b[].d`（Base64 UTF-8 JSON）。只有在浏览器登录态下才会收到评论帧，且**只有该通道能拿到 `profile.user_id`（uid）**。
- **兜底通道 DOM MutationObserver**：真实结构为 `.virtual-list-item[custom-key]` → `.msg-wrapper.role-user` → `.msg-content` → `.nickname` + `.content`。
  - **正文必须读 `.content`**：`.msg-content.textContent` 是「昵称 + 正文」拼接，直接落库会让正文重复昵称；
  - 表情是 `<img class="emoji-img" alt="[害羞R]">`，需用 `alt` 还原，`textContent` 会丢表情；
  - **uid 在 DOM 中不存在**（无 `data-user-id`、昵称也不是链接），匿名访问时只能为空；
  - 系统提示（`来了` / `为主播点赞了` / `关注了主播` / `分享了直播间`）混在同一虚拟列表中：`role-user` 以外的 wrapper 直接丢弃，「为主播点赞了」归类为 `like`，其余系统提示丢弃，禁止当普通评论落库。
- **去重**：WS 与 DOM 交叉窗口 5s（同一 `user|text`）；DOM 虚拟列表滚动回收/整段重渲染会重新产出历史评论，需额外用 5 分钟窗口 + `custom-key` 稳定消息 ID 抑制；首次 DOM 扫描只登记已挂载历史（`seedOnly`），不发送。

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

**循环依赖处理**：`danmaku-session.js` 与 `recording.js` 之间存在互调关系，全部使用**静态顶层 import**。

> ⚠️ **禁止在 Service Worker 模块图中使用动态 `import()`**：MV3 明确禁止（`import() is disallowed on ServiceWorkerGlobalScope by the HTML specification`），调用时会抛错。如果该 `import()` 位于 `try/catch` 内且 catch 为空，故障会被完全静默——曾导致 `checkRecordingAndUpdateSession()` 里 `isEnvironmentRecording` 永远加载失败，`isSending` 永远为 false，弹幕只缓冲不发送。
>
> ESM 静态循环导入在此处是安全的：互相引用的函数只在运行时事件回调里调用，模块求值阶段不触发。

## 小红书开播发现（被动嗅探，v1.2.0）

`content/inject.js` 在 MAIN world 劫持 `fetch` / `XMLHttpRequest` 的**响应**，解析页面自身已经发出的请求，不构造签名、不额外发请求：

| 来源 | 接口 / 位置 | 关键字段 |
| --- | --- | --- |
| 直播广场 | `live-room.xiaohongshu.com/api/sns/red/live/web/feed/v1/squarefeed` | `live.tRoomInfo`（roomId/link/cover）、`live.tLiveHostInfo`（userId/nickname）、`roomExtraInfo.live_stream_info`（`master_url` 原画流） |
| 搜索用户卡 | `edith.xiaohongshu.com/api/sns/web/v1/search/onebox` | `user_one_box`：`id`、`red_id`、`live_info.room_id/status/link`（`flvUrl`） |
| 关注/推荐流 | `edith.xiaohongshu.com/api/sns/web/v1/homefeed`、`/feed/*` | `note.liveCard.live` + `note.user` |
| 直播间页面 | `window.__INITIAL_STATE__.liveStream`（Vue ref，需取 `_value`） | `roomData.hostInfo.userId`（**直播间 → 主页 uid**）、`roomInfo.roomId/deeplink/pullConfig` |

- 解析结果经 `window.postMessage({type:'xhs_live_info', items})` → `content.js` → `ACTIONS.XHS_LIVE_INFO` → `core/xhs-live-discovery.js`。
- `items` 统一为 `{platform:'xiaohongshu', live, roomId, userId, redId, nickname, title, streamUrl, coverUrl, roomUrl, source}`。
- 直播间页面的 `liveStream` 是 Vue ref，`roomData` / `hostInfo` / `roomInfo` 也需要 `_value` 解包；`readXhsLiveRoomState()` 每 3 秒轮询页面内存（SPA 路由切换后状态才就绪）。
- 匹配配置：每个环境新增 `xiaohongshuAuthors`，每行支持 `531916795`（小红书号）、24 位用户 ID、主页/直播间链接、`昵称|ID` 或纯昵称。匹配优先级：用户 ID > 小红书号 > 昵称。
- 命中后调用 `sendToEnvironments()`，请求体额外携带 `host_user_id`、`live_room_id`，与后端 ADR-021 的稳定目标归并配合。
- 去重：`notifiedRooms` 中使用 `xhs:{roomId}` key，仅在后端确认接受（`activeCount > 0`）后持久化；失败会在下一批页面响应时重试。

## Testing

No test framework exists. Manual testing only: load extension, navigate to `live.kuaishou.com`, verify badge count and popup.

## Style

Plain JavaScript, no TypeScript, no formatter. Imports use full `.js` extensions. All comments and strings are in Chinese. 新增消息类型时必须使用 `lib/constants.js` 中的 `ACTIONS` 常量，禁止硬编码 action 字符串。新增运行时状态必须放入 `core/state.js`，禁止在各业务模块中持有局部状态变量。
