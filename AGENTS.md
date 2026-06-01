# Live Stream Sniffer — Chrome Extension

## Setup

No build, no bundler, no package manager. Load as unpacked extension in `chrome://extensions` (dev mode). After editing any JS/HTML file, reload the extension on that page.

## Architecture

- **Manifest V3** — service worker (`background.js`) is ESM (`type: "module"`).
- All files are plain ES modules that `import` from each other directly.
- **Entrypoints**: `background.js` (service worker), `popup.js` (popup UI), `options.js` (settings page), `content.js` (injected on `live.kuaishou.com`).
- Config + config-loading all in `config.js` — no separate utils module.
- User settings (`notifyApiUrl`, `statusApiUrl`, `followedAuthors`) persisted via `chrome.storage.sync`; detected streams use `chrome.storage.local`.

## Key constraints

- `host_permissions` limit to `*.kuaishou.com`, `*.yximgs.com`, `localhost:1123`.
- Auto-record triggers only when tab title includes `KSG无言` (`background.js`).
- Two sources of stream URL detection:
  - `chrome.webRequest` captures `.flv` URLs; quality selection via `QUALITY_WEIGHTS` with 2-second debounce (`background.js`).
  - `content.js` reads `<video>.currentSrc` every 3 seconds (also acts as MV3 SW keepalive). Handled via `onMessage` in background.
- Recording-aware polling: when `sendToBackend` confirms recording active, sets `activeRecordingRoomUrl`; subsequent `checkFollowingLivings` ticks query backend `/status` first and skip Kuaishou API if still recording (`background.js`).
- Backend endpoints (configurable in settings):
  - `POST {notifyApiUrl}` with JSON body `{ url, title, room_url, caption }` — start recording.
  - `GET {statusApiUrl}?url={roomUrl}` — check if already recording.
  - `POST {danmakuBatchApiUrl}` with JSON body `{ room_url, events, session_start_ms, title }` — push danmaku batch.
- `config.js` defines multiple environments (`production` → `:1123`, `development` → `:3001`).
  - Each environment has its own toggle, notify API URL, and status API URL.
  - When `sendToBackend` is called, it loops through all **enabled** environments and sends requests to each.
  - Author list is shared across all environments.
- `getConfig()` returns `{ environments: [...], followedAuthors: [...] }`.

## Danmaku architecture

**数据流**：`inject.js` (MAIN world, WebSocket hook) → `content.js` (ISOLATED world, postMessage relay, 5s buffer) → `background.js` (service worker, 5s batch flush) → 后端 `POST /api/danmaku/batch`

**录制状态感知**（`background.js`）：弹幕发送严格跟随后端录制状态，未录制时仅缓冲不发送。

- `danmakuSessions` Map 中每个会话有 `isSending` 和 `stopping` 标记
- `startDanmakuSession()` 创建会话时 `isSending=false`（缓冲模式）
- `checkRecordingAndUpdateSession(roomUrl)` 查询后端录制状态并自动启停：
  - 录制开始 → `isSending=true`，开启发送
  - 录制结束 → 先 flush 剩余缓冲，再 `isSending=false`
- 触发时机：`danmakuReady` 立即检查 + 定时器每 10 秒周期检查 + `danmakuBatch` 自动创建时检查
- `flushDanmakuBatch()` 检查 `isSending`，为 false 时跳过发送
- 缓冲区上限 5000 条事件，超出丢弃最早事件（防止长时间不录制时内存泄漏）
- `stopDanmakuSession(roomUrl, forceFlush)` 使用 `stopping` 标记 + 同步 drain 防止竞态

## Testing

No test framework exists. Manual testing only: load extension, navigate to `live.kuaishou.com`, verify badge count and popup.

## Style

Plain JavaScript, no TypeScript, no formatter. Imports use full `.js` extensions. All comments and strings are in Chinese.
