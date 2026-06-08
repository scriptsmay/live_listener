# 项目重构方案

## 现状诊断

项目当前共 3925 行代码（不含文档），分布在 10 个根目录文件中。核心问题集中在五个方面。

**background.js 是主要瓶颈**。1076 行代码承载了至少 7 个不同职责：直播流检测与画质选择、录制请求推送、弹幕会话管理、弹幕批量发送、关注列表轮询、消息路由、状态恢复。每次修改任何一个功能都需要在这个文件中定位和编辑，增加了引入回归的风险。更关键的是，消息路由逻辑（`chrome.runtime.onMessage.addListener` 内部的大 switch）本身就有 200 多行，如果拆分时不独立出来，background.js 仍然会残留一个臃肿的入口。

**模块间状态散落**。`activeRecordingRoomUrl`、`notifiedRooms`、`bestStreamsByRoom`、`detectedStreams` 等状态变量散落在 background.js 的不同代码段中。拆分模块后如果不集中管理，这些状态会被分散到 stream-detector、following-poll、recording 等不同模块中，形成隐式的跨模块耦合。

**模块间直接调用链过长**。当前 stream-detector 检测到流后直接调用 recording 的 `sendToEnvironments()`，recording 又直接操作 danmaku-session 的状态。这条调用链使得新增功能（如通知、统计、Webhook）必须修改上游模块。

**代码重复散布在多个文件**。`fetchJson()` 在 background.js 和 popup.js 中各实现了一份（完全相同的 30 行）。`isKuaishouLiveRoomUrl()` 在 background.js、popup.js、content.js 三处定义。`isEnvironmentRecording()` 在 background.js 和 popup.js 中重复。这些重复不仅浪费代码行数，更危险的是修改时容易遗漏同步。

**消息协议不统一**。content.js 与 background.js 之间使用大写 `Message` 字段（`addMedia`、`danmakuReady`、`danmakuBatch`、`danmakuStop`），popup.js 与 background.js 之间使用小写 `action` 字段。消息名作为魔法字符串散落在各文件中，重命名时容易漏改。

## 目标目录结构

```
chrome_live_listener/
├── manifest.json
├── icon.png
├── background.js                    # Service Worker 入口（~30 行，纯胶水）
├── core/                            # 核心业务逻辑
│   ├── state.js                     # 统一状态仓库（集中管理所有运行时状态）
│   ├── event-bus.js                 # 事件总线（模块间解耦通信）
│   ├── message-router.js            # 消息路由（background onMessage 的唯一入口）
│   ├── config.js                    # 环境配置 + getConfig()
│   ├── stream-detector.js           # 直播流检测、去重
│   ├── stream-quality.js            # 清晰度权重、画质选择（平台相关业务逻辑）
│   ├── recording.js                 # 录制请求推送、状态查询、录制拒绝处理
│   ├── danmaku-session.js           # 弹幕会话管理、批量发送、录制状态轮询
│   ├── danmaku-switch.js            # 弹幕采集开关
│   └── following-poll.js            # 关注列表轮询、开播检测
├── lib/                             # 公共工具层（纯工具，无业务逻辑，无 Chrome API 副作用）
│   ├── http.js                      # fetchJson 统一封装（仅通用 HTTP 能力）
│   ├── url.js                       # isKuaishouLiveRoomUrl、getLiveRoomUrlFromRequest
│   ├── constants.js                 # 消息 action 名、storage key 等全局常量
│   └── logger.js                    # 统一日志封装（支持 debug 开关）
├── content/                         # 内容脚本
│   ├── content.js                   # 视频嗅探 + 弹幕转发中继
│   └── inject.js                    # MAIN world WebSocket hook（IIFE，不可用 ESM）
├── danmaku/                         # 弹幕解析（独立子模块）
│   └── parser.js                    # 标准化 + 过滤
├── ui/                              # 用户界面
│   ├── popup.html
│   ├── popup.js
│   ├── popup.css                    # 从 popup.html 内联样式提取
│   ├── options.html
│   ├── options.js
│   └── options.css                  # 从 options.html 内联样式提取
└── docs/                            # 文档
```

## 各模块拆分方案

### 1. lib/ — 公共工具层

lib 层只放与快手业务无关的通用工具。任何依赖 `env.*`、快手域名、业务常量的函数都不属于这一层。

**lib/http.js**：纯粹的 HTTP 请求封装，不含任何业务判断。

```js
// lib/http.js
export const REQUEST_TIMEOUT_MS = 8000;

export async function fetchJson(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    const text = await resp.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
    }
    return { ok: resp.ok, status: resp.status, data };
  } finally {
    clearTimeout(timer);
  }
}
```

注意：原方案中的 `isEnvironmentRecording()` 依赖 `env.statusApiUrl`，属于业务逻辑，已移至 `core/recording.js`。

**lib/url.js**：URL 校验和提取，将三处重复的 `isKuaishouLiveRoomUrl()` 和 background.js 中的 `getLiveRoomUrlFromRequest()` 合并。

```js
// lib/url.js
export function isKuaishouLiveRoomUrl(url) { /* ... */ }
export function getLiveRoomUrlFromRequest(details, tab) { /* ... */ }
```

**lib/constants.js**：集中管理所有消息 action 名称和 storage key，消除魔法字符串。

```js
// lib/constants.js
export const ACTIONS = {
  // content → background
  ADD_MEDIA: 'add_media',
  DANMAKU_READY: 'danmaku_ready',
  DANMAKU_BATCH: 'danmaku_batch',
  DANMAKU_STOP: 'danmaku_stop',
  // popup → background
  GET_DANMAKU_STATUS: 'get_danmaku_status',
  TOGGLE_DANMAKU: 'toggle_danmaku',
  CLEAR_COUNT: 'clear_count',
  TOGGLE_MONITOR: 'toggle_monitor',
  RECHECK_FOLLOWING: 'recheck_following',
  // background → content
  START_DANMAKU: 'start_danmaku',
  STOP_DANMAKU: 'stop_danmaku',
  // background → popup
  RECORDING_REJECTED: 'recording_rejected',
};

export const STORAGE_KEYS = {
  STREAMS: 'streams',
  NOTIFIED_ROOMS: 'notifiedRooms',
  ACTIVE_RECORDING_ROOM: 'activeRecordingRoomUrl',
  MONITOR_ENABLED: 'monitorEnabled',
  DANMAKU_ENABLED: 'danmakuEnabled',
  KUAISHOU_VISITED: 'kuaishouVisited',
  LAST_REQ_STATUS: 'lastReqStatus',
};
```

使用方式：

```js
import { ACTIONS } from '../lib/constants.js';

if (message.action === ACTIONS.ADD_MEDIA) { /* ... */ }
```

**lib/logger.js**：统一日志封装，支持 debug 开关。

```js
// lib/logger.js
let debugEnabled = false;

export function setDebugMode(enabled) { debugEnabled = enabled; }
export function debug(tag, ...args) { if (debugEnabled) console.log(tag, ...args); }
export function info(tag, ...args) { console.log(tag, ...args); }
export function warn(tag, ...args) { console.warn(tag, ...args); }
```

### 2. core/state.js — 统一状态仓库

这是整个重构的架构关键。所有运行时状态集中存储在 state.js 中，各业务模块通过 getter/setter 访问，而非各自持有局部变量。核心收益：模块拆分后不会出现"状态散落在 5 个文件中，调试时需要逐个排查"的问题；Service Worker 重启时只需一个 `restoreState()` 就能恢复全部状态。

```js
// core/state.js
import { STORAGE_KEYS } from '../lib/constants.js';

// ===== 内存状态（Service Worker 重启后丢失，需从 storage 恢复） =====

const state = {
  // 直播流检测
  lastUrl: '',
  detectedStreams: [],

  // 清晰度选择（临时状态，仅内存）
  bestStreamsByRoom: new Map(),

  // 录制状态
  activeRecordingRoomUrl: null,

  // 弹幕会话
  danmakuSessions: new Map(),      // roomUrl -> session 对象
  danmakuBatchBuffer: new Map(),   // roomUrl -> events[]
  autoOpenedTabs: new Map(),       // roomUrl -> tabId

  // 关注轮询
  notifiedRooms: new Set(),
};

export function getState() { return state; }

export function updateState(partial) {
  Object.assign(state, partial);
}

// ===== 持久化写入（原子操作，防并发写入覆盖） =====
//
// Chrome 扩展的 onMessage、webRequest、alarms 是完全并发异步触发的。
// 如果两个事件同时读取→修改→写入 storage，会导致 Race Condition。
// 因此所有涉及"读取-变更-写入"的持久化操作必须通过以下原子接口执行。

let _storageLock = Promise.resolve();

function withStorageLock(fn) {
  const next = _storageLock.then(fn, fn);
  _storageLock = next.catch(() => {});
  return next;
}

export function persistStreams(streams) {
  return withStorageLock(async () => {
    state.detectedStreams = streams;
    await chrome.storage.local.set({ [STORAGE_KEYS.STREAMS]: streams });
  });
}

/** 原子追加一条直播流记录，防止并发写入覆盖 */
export async function atomicAppendStream(stream) {
  return withStorageLock(async () => {
    const result = await chrome.storage.local.get(STORAGE_KEYS.STREAMS);
    const existing = Array.isArray(result[STORAGE_KEYS.STREAMS]) ? result[STORAGE_KEYS.STREAMS] : [];
    const updated = [...existing, stream].slice(-100);
    state.detectedStreams = updated;
    await chrome.storage.local.set({ [STORAGE_KEYS.STREAMS]: updated });
  });
}

export function persistNotifiedRooms(rooms) {
  return withStorageLock(async () => {
    state.notifiedRooms = rooms;
    await chrome.storage.local.set({ [STORAGE_KEYS.NOTIFIED_ROOMS]: [...rooms] });
  });
}

export function persistActiveRecording(roomUrl) {
  return withStorageLock(async () => {
    state.activeRecordingRoomUrl = roomUrl;
    await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_RECORDING_ROOM]: roomUrl });
  });
}

export function clearActiveRecording() {
  return withStorageLock(async () => {
    state.activeRecordingRoomUrl = null;
    await chrome.storage.local.remove(STORAGE_KEYS.ACTIVE_RECORDING_ROOM);
  });
}

// ===== Service Worker 启动时恢复 =====

export async function restoreState() {
  const result = await chrome.storage.local.get([
    STORAGE_KEYS.NOTIFIED_ROOMS,
    STORAGE_KEYS.STREAMS,
    STORAGE_KEYS.ACTIVE_RECORDING_ROOM,
  ]);

  if (result[STORAGE_KEYS.NOTIFIED_ROOMS]) {
    for (const id of result[STORAGE_KEYS.NOTIFIED_ROOMS]) {
      state.notifiedRooms.add(id);
    }
  }

  if (Array.isArray(result[STORAGE_KEYS.STREAMS])) {
    state.detectedStreams = result[STORAGE_KEYS.STREAMS].slice(-100);
  }

  state.activeRecordingRoomUrl = result[STORAGE_KEYS.ACTIVE_RECORDING_ROOM] || null;
}
```

各业务模块使用方式：

```js
// core/stream-detector.js
import { atomicAppendStream } from './state.js';

function addDetectedStream(stream) {
  // 原子操作：读取→追加→写入在锁内完成，不会与其他并发写入冲突
  atomicAppendStream(stream);
}
```

### 3. core/event-bus.js — 事件总线

用事件驱动替代模块间的直接函数调用，使 stream-detector 等上游模块不需要知道下游有哪些消费者。未来增加通知、统计、Webhook 等功能时，只需新增监听器，不修改任何已有模块。

```js
// core/event-bus.js

const listeners = new Map(); // event -> Set<callback>

export function on(event, callback) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(callback);
}

export function off(event, callback) {
  listeners.get(event)?.delete(callback);
}

export function emit(event, payload) {
  listeners.get(event)?.forEach((cb) => {
    try { cb(payload); } catch (err) {
      console.warn(`[EventBus] handler error on '${event}':`, err);
    }
  });
}

// 事件名称常量（也可放入 lib/constants.js）
export const EVENTS = {
  STREAM_DETECTED: 'stream_detected',
  RECORDING_STARTED: 'recording_started',
  RECORDING_STOPPED: 'recording_stopped',
  RECORDING_REJECTED: 'recording_rejected',
  DANMAKU_SESSION_CREATED: 'danmaku_session_created',
  DANMAKU_SENDING_STARTED: 'danmaku_sending_started',
  DANMAKU_SENDING_STOPPED: 'danmaku_sending_stopped',
};
```

使用方式——stream-detector 只负责发射事件：

```js
// core/stream-detector.js
import { emit, EVENTS } from './event-bus.js';

function onStreamDetected(stream) {
  // ... 更新 state ...
  emit(EVENTS.STREAM_DETECTED, stream);
}
```

recording.js 监听事件并处理录制逻辑：

```js
// core/recording.js
import { on, EVENTS } from './event-bus.js';

on(EVENTS.STREAM_DETECTED, async (stream) => {
  await sendToEnvironments(stream);
});
```

### 4. core/message-router.js — 消息路由

将 `chrome.runtime.onMessage.addListener` 内部的 switch 逻辑完整提取为独立模块。background.js 最终只剩一行注册代码。

```js
// core/message-router.js
import { ACTIONS } from '../lib/constants.js';
import { getState } from './state.js';
import { getConfig } from './config.js';
import { handleContentStream } from './stream-detector.js';
import { sendToEnvironments, isEnvironmentRecording } from './recording.js';
import {
  startDanmakuSession, stopDanmakuSession,
  getDanmakuStatus, checkRecordingAndUpdateSession,
} from './danmaku-session.js';
import { setDanmakuEnabled } from './danmaku-switch.js';
import { checkFollowingLivings } from './following-poll.js';
import { isKuaishouLiveRoomUrl } from '../lib/url.js';

export function handleMessage(request, sender, sendResponse) {
  switch (request.action) {

    case ACTIONS.GET_DANMAKU_STATUS: {
      const sessions = getDanmakuStatus();
      getConfig().then((config) => {
        sendResponse({ sessions, danmakuEnabled: config.danmakuEnabled ?? false });
      });
      return true; // 保持异步通道
    }

    case ACTIONS.CLEAR_COUNT: {
      const s = getState();
      s.detectedStreams = [];
      chrome.action.setBadgeText({ text: '' });
      chrome.storage.local.set({ streams: [] }, () => {
        sendResponse({ status: 'cleared' });
      });
      return true;
    }

    case ACTIONS.TOGGLE_DANMAKU: {
      setDanmakuEnabled(request.enabled).then(() => {
        sendResponse({ status: 'ok', danmakuEnabled: request.enabled });
      });
      return true;
    }

    case ACTIONS.TOGGLE_MONITOR: {
      if (request.enabled) {
        getState().notifiedRooms.clear();
        chrome.storage.local.remove('notifiedRooms');
        checkFollowingLivings();
      }
      sendResponse({ status: 'ok' });
      break;
    }

    case ACTIONS.RECHECK_FOLLOWING: {
      getState().notifiedRooms.clear();
      chrome.storage.local.remove('notifiedRooms');
      checkFollowingLivings();
      sendResponse({ status: 'recheck_started' });
      break;
    }

    // ===== 来自 content.js 的消息 =====

    case ACTIONS.ADD_MEDIA: {
      const tab = sender.tab;
      if (!tab || !tab.title) return;
      if (!isKuaishouLiveRoomUrl(tab.url)) return true;
      handleContentStream({ url: request.url, title: tab.title, roomUrl: tab.url });
      return true;
    }

    case ACTIONS.DANMAKU_READY: {
      const tab = sender.tab;
      const roomUrl = tab?.url || '';
      if (!isKuaishouLiveRoomUrl(roomUrl)) return;
      startDanmakuSession(roomUrl, request.sessionStartMs || Date.now(),
        tab.id, request.url || roomUrl, request.title || tab.title || '');
      checkRecordingAndUpdateSession(roomUrl).catch(() => {});
      return;
    }

    case ACTIONS.DANMAKU_BATCH: {
      const tab = sender.tab;
      const roomUrl = tab?.url || '';
      if (!isKuaishouLiveRoomUrl(roomUrl)) return;
      // ... 缓冲逻辑（移入 danmaku-session.js 的 handleDanmakuBatch）
      return;
    }

    case ACTIONS.DANMAKU_STOP: {
      const roomUrl = request.url || sender.tab?.url || '';
      if (roomUrl) stopDanmakuSession(roomUrl, true).catch(() => {});
      return;
    }
  }
}
```

### 5. core/ — 业务逻辑模块

**core/config.js**：从根目录 config.js 迁移，移除清晰度相关常量（已迁至 core/stream-quality.js）。保留环境配置、API 路径常量和 `getConfig()` 函数。

**core/stream-detector.js**：从 background.js 提取直播流检测相关逻辑，包括 `addDetectedStream()`、`autoChooseBest()`。通过 event-bus 发射 `STREAM_DETECTED` 事件，不再直接调用 recording 模块。对外暴露 `handleWebRequest(details)` 和 `handleContentStream(stream)` 两个入口函数。

**core/stream-quality.js**：从 config.js 提取清晰度权重/标签数据，从 background.js 提取 `getQualityWeight()`，从 popup.js 提取 `getQualityInfo()`。这是平台相关业务逻辑（不同平台有不同的清晰度体系），放在 core/ 而非 lib/。

```js
// core/stream-quality.js
export const QUALITY_LABELS = [ /* 从 config.js 迁移 */ ];
export const QUALITY_WEIGHTS = { /* 从 config.js 迁移 */ };
export function getQualityWeight(url) { /* 从 background.js 迁移 */ }
export function getQualityInfo(url) { /* 从 popup.js 迁移 */ }
```

**core/recording.js**：从 background.js 提取录制推送逻辑，包括 `sendToEnvironments()`、`sendToBackend()`、`isEnvironmentRecording()`（从原 lib/http.js 移入，因为依赖 env.statusApiUrl 属于业务逻辑）、`activateDanmakuForRoom()`、`deactivateDanmakuForRoom()`。监听 event-bus 的 `STREAM_DETECTED` 事件来触发录制。

**core/danmaku-session.js**：从 background.js 提取弹幕会话管理，包括会话生命周期函数（start/stop/activate/deactivate）、`handleDanmakuBatch()`（接收 content.js 聚合后的弹幕批次）、`checkRecordingAndUpdateSession()`。对外暴露 `getDanmakuStatus()` 供 message-router 查询。**注意：本模块不在 Background 中维护任何秒级定时器**——弹幕聚合由 content.js（网页端，不会休眠）完成，Background 仅做无状态的"收到即转发"，彻底规避 SW 休眠导致定时器失效的问题（详见"风险与注意事项"章节）。

**core/danmaku-switch.js**：从 background.js 提取弹幕采集开关逻辑，包括 `setDanmakuEnabled()` 和 `autoDisableDanmakuIfIdle()`。

**core/following-poll.js**：从 background.js 提取关注列表轮询，包括 `checkFollowingLivings()`、`handleStreamerOnline()`、`setFollowReqStatus()`。对外暴露 `initAlarms()` 负责注册 alarm 定时器。

### 6. content/ — 内容脚本

**content/content.js**：从根目录 content.js 迁移。视频嗅探逻辑保持不变，`isLiveRoomPage()` 只有 4 行，直接内联（content_scripts 不支持 ESM，无法 import lib/）。

**content/inject.js**：从根目录 inject.js 迁移。该文件作为 MAIN world 注入脚本，不能使用 ES Module，保持 IIFE 模式不变。

### 7. danmaku/ — 弹幕解析

**danmaku/parser.js**：从根目录 danmaku-parser.js 迁移，逻辑不变。

### 8. ui/ — 用户界面

**popup.css / options.css**：将 popup.html 和 options.html 中的内联 `<style>` 块提取为独立 CSS 文件。popup.html 当前有约 570 行内联样式，options.html 约 200 行。提取后 HTML 文件只保留结构，通过 `<link>` 引入样式。

**popup.js**：从根目录迁移，同时移除重复的 `fetchJson()`、`isEnvironmentRecording()`、`isKuaishouLiveRoomUrl()`，改为从 lib/ 导入。

**options.js**：从根目录迁移，逻辑不变。

### 9. background.js — 精简为纯胶水层

重构后的 background.js 缩减至约 30 行，职责仅为：导入核心模块、恢复状态、注册事件监听。

```js
// background.js（重构后）
import { restoreState } from './core/state.js';
import { handleMessage } from './core/message-router.js';
import { handleWebRequest } from './core/stream-detector.js';
import { initAlarms } from './core/following-poll.js';
import { setDebugMode } from './lib/logger.js';

// 恢复运行状态
await restoreState();

// 初始化
initAlarms();
setDebugMode(false); // 后续可读取 storage 中的 debug 配置

// 注册监听器
chrome.webRequest.onBeforeRequest.addListener(handleWebRequest, {
  urls: ['<all_urls>'],
});
chrome.runtime.onMessage.addListener(handleMessage);

chrome.notifications.onClicked.addListener((notifId) => {
  // ... 通知点击处理 ...
});

console.log('[Live Stream Sniffer] KS直播监测插件已启动');
```

## 消息协议统一

将所有跨模块消息统一为 `{ action: '...' }` 格式，废弃 content.js 中的 `{ Message: '...' }` 大写写法。配合 `lib/constants.js` 的 `ACTIONS` 常量使用，消除魔法字符串。具体变更：

| 现有写法                           | 统一后                        | 对应常量                   | 方向                 |
| ---------------------------------- | ----------------------------- | -------------------------- | -------------------- |
| `{ Message: 'addMedia' }`          | `{ action: 'add_media' }`     | `ACTIONS.ADD_MEDIA`        | content → background |
| `{ Message: 'danmakuReady' }`      | `{ action: 'danmaku_ready' }` | `ACTIONS.DANMAKU_READY`    | content → background |
| `{ Message: 'danmakuBatch' }`      | `{ action: 'danmaku_batch' }` | `ACTIONS.DANMAKU_BATCH`    | content → background |
| `{ Message: 'danmakuStop' }`       | `{ action: 'danmaku_stop' }`  | `ACTIONS.DANMAKU_STOP`     | content → background |
| `{ action: 'get_danmaku_status' }` | 不变                          | `ACTIONS.GET_DANMAKU_STATUS` | popup → background |
| `{ action: 'toggle_danmaku' }`     | 不变                          | `ACTIONS.TOGGLE_DANMAKU`   | popup → background   |
| `{ action: 'clear_count' }`        | 不变                          | `ACTIONS.CLEAR_COUNT`      | popup → background   |
| `{ action: 'toggle_monitor' }`     | 不变                          | `ACTIONS.TOGGLE_MONITOR`   | popup → background   |
| `{ action: 'recheck_following' }`  | 不变                          | `ACTIONS.RECHECK_FOLLOWING`| popup → background   |
| `{ action: 'start_danmaku' }`      | 不变                          | `ACTIONS.START_DANMAKU`    | background → content |
| `{ action: 'stop_danmaku' }`       | 不变                          | `ACTIONS.STOP_DANMAKU`     | background → content |
| `{ action: 'recording_rejected' }` | 不变                          | `ACTIONS.RECORDING_REJECTED`| background → popup |

命名风格统一为 snake_case，全部使用 `action` 字段。

## manifest.json 调整

重构后需要更新 manifest 中的文件路径引用：

```json
{
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["*://live.kuaishou.com/*"],
      "js": ["content/content.js"],
      "run_at": "document_start"
    }
  ],
  "web_accessible_resources": [
    {
      "resources": ["content/inject.js"],
      "matches": ["*://live.kuaishou.com/*"]
    }
  ],
  "options_page": "ui/options.html"
}
```

同时清理 `host_permissions` 中重复的条目：`http://localhost:*/*` 已覆盖 `http://localhost:1123/*` 和 `http://localhost:3001/*`，保留通配即可。

### 安全性与权限审查

重构 manifest.json 时，需要额外审查以下安全要点：

**host_permissions 最小化**：当前 `host_permissions` 中声明了 `http://localhost:*/*` 和 `<all_urls>`（用于 webRequest）。应评估是否可以将 `host_permissions` 改为 **Optional Permissions**（运行时动态申请），仅在用户首次开启录制功能时请求后端 API 的访问权限，而非安装时一次性授权所有 localhost 端口。

**content_scripts 的 matches 严格限制**：`content_scripts` 的 `matches` 必须严格限制在 `*://live.kuaishou.com/*`，防止 `inject.js`（含 WebSocket hook）被注入到无关页面。`web_accessible_resources` 中的 `inject.js` 的 `matches` 同样需要限制为 `*://live.kuaishou.com/*`，避免其他网站通过 `chrome.runtime.getURL` 探测到扩展的存在。

**webRequest 的 URLs 范围收窄**：当前 `chrome.webRequest.onBeforeRequest.addListener` 注册的 `urls` 为 `['<all_urls>']`，实际上只需要捕获快手直播间的流请求。建议在 `stream-detector.js` 中将 filter 收窄为快手相关域名，减少对其他网站网络请求的不必要监听，也有助于通过 Chrome Web Store 的审核。

## 核心数据结构定义（JSDoc）

引入事件总线后，模块间变为松耦合通信。为避免 Payload 字段名不一致（如 `room_url` vs `roomUrl`），以下定义核心数据结构的 JSDoc 规范，重构时所有模块应严格遵守。

```js
/**
 * 直播流对象 — stream-detector 检测到流后发射的核心数据单元
 * @typedef {Object} StreamObject
 * @property {string} url          - 直播流 CDN 地址
 * @property {string} roomUrl      - 直播间页面 URL（如 https://live.kuaishou.com/u/xxx）
 * @property {string} title        - 直播间标题
 * @property {string} quality      - 清晰度标识（如 'super'、'high'、'standard'）
 * @property {number} detectedAt   - 检测时间戳（Date.now()）
 */

/**
 * 弹幕事件 — content.js 聚合后通过 ACTIONS.DANMAKU_BATCH 发送的批次
 * @typedef {Object} DanmakuBatchPayload
 * @property {string} action       - 固定为 ACTIONS.DANMAKU_BATCH
 * @property {string} roomUrl      - 直播间页面 URL
 * @property {Array<DanmakuItem>} items - 聚合的弹幕条目数组（通常 2~3 秒内的弹幕）
 */

/**
 * 单条弹幕 — 从 WebSocket 解析后的标准化弹幕对象
 * @typedef {Object} DanmakuItem
 * @property {string} user         - 发送者昵称
 * @property {string} content      - 弹幕文本内容
 * @property {number} timestamp    - 弹幕时间戳（ms）
 * @property {string} type         - 弹幕类型（如 'text'、'gift'、'enter'）
 */

/**
 * 弹幕会话 — danmaku-session.js 管理的会话状态
 * @typedef {Object} DanmakuSession
 * @property {string} roomUrl      - 直播间页面 URL
 * @property {number} sessionStartMs - 会话开始时间戳
 * @property {number} tabId        - 对应标签页 ID
 * @property {string} streamUrl    - 弹幕数据源 URL
 * @property {string} title        - 直播间标题
 * @property {boolean} active      - 会话是否处于活跃状态
 * @property {number} totalCount   - 累计接收弹幕数
 */

/**
 * 录制环境配置 — config.js 中 getConfig() 返回的环境信息
 * @typedef {Object} EnvironmentConfig
 * @property {string} apiUrl       - 录制后端 API 地址
 * @property {string} statusApiUrl - 录制状态查询 API 地址
 * @property {string} name         - 环境名称（如 'local'、'remote'）
 * @property {boolean} danmakuEnabled - 该环境是否启用弹幕录制
 */
```

以上类型定义应在 `core/state.js` 或 `lib/types.js` 中以 JSDoc 注释形式存在，各模块通过 `@param {StreamObject} stream` 等方式引用，IDE 可提供自动补全和类型检查。

## 实施阶段

建议分 5 个阶段执行，每个阶段独立可验证，完成后可单独提交。阶段顺序的核心原则：**先统一协议，再拆模块**——避免先拆模块再改协议导致所有新模块返工。

**阶段一：提取 lib/ 公共工具层**。创建 lib/ 目录，提取 http.js（仅 fetchJson）、url.js、constants.js。修改 background.js、popup.js、content.js 的 import 引用，删除各自的重复实现。同步将所有 `{ Message: '...' }` 替换为 `{ action: '...' }` 并使用 `ACTIONS` 常量。此阶段不改业务逻辑，纯粹消除重复代码和统一协议，验证方法是功能回归测试。

**阶段二：统一消息协议**。将 content.js 中所有 `{ Message: 'addMedia' }` 等改为 `{ action: 'add_media' }`，同步修改 background.js 的接收方。消息协议属于架构基础，在拆模块之前完成可以避免后续返工。此阶段与阶段一可以合并为一次提交。

**阶段三：渐进式拆分核心业务模块（避免一次性大面积冲突）**

这是改动最大的阶段，采用"渐进式绞杀"策略，将 background.js 分 5 个递进子步骤逐步掏空，确保每次提交的 Diff 控制在几百行以内，而不是一次性动上千行代码。

3.1 **基础设施先行**：引入 `state.js`（含原子操作接口）、`event-bus.js` 和 `config.js`。在现有 background.js 大文件中，改用 `getState()` / `atomicAppendStream()` 读写状态，确保状态层先统一。此步骤不拆分任何业务逻辑，仅替换状态访问方式和建立事件通信管道。

3.2 **绞杀边缘模块**：将 `following-poll.js`（关注列表轮询）完整剥离。该模块是 background.js 中最独立的子系统——它只依赖 `chrome.alarms` 和自身的 notifiedRooms 状态，与弹幕、录制、流检测均无直接耦合。剥离后可以立即验证"关注开播检测 + 通知"功能是否正常，作为拆分流程的首个校验点。

3.3 **剥离弹幕子系统**：迁移 `danmaku-session.js` 与 `danmaku-switch.js`。重点处理好 SW 休眠下的高频缓冲策略——弹幕聚合逻辑移入 content.js（前端 2~3 秒 Buffer），Background 仅做无状态转发（详见"风险与注意事项"中的弹幕高频定时器章节）。

3.4 **核心链路重构与解耦**：拆分 `stream-detector.js`、`stream-quality.js`、`recording.js`。将原来的直接函数调用（stream-detector → recording.sendToEnvironments）改为 `emit(EVENTS.STREAM_DETECTED)` 事件驱动。这是解耦最关键的一步，完成后 stream-detector 不再知道 recording 的存在。

3.5 **收尾路由**：上线 `message-router.js`，将 background.js 中的 onMessage switch 逻辑整体迁入，background.js 精简为 ~30 行的纯胶水层。

建议每完成一个子步骤后做一次功能回归测试，确认该子步骤涉及的模块工作正常。

**阶段四：移动 content/ 和 ui/ 文件**。将 content.js、inject.js 迁移到 content/，将 popup.html/js、options.html/js 迁移到 ui/，将 danmaku-parser.js 迁移到 danmaku/parser.js，提取 CSS 为独立文件。同步更新 manifest.json 路径引用。此阶段是纯文件移动和样式分离。

**阶段五：添加 logger 和收尾**。引入 lib/logger.js，将散落各处的 console.log/warn 替换为统一日志调用。清理无用注释和已注释的代码块（如 background.js 中被注释的 `chrome.notifications.create`）。更新 AGENTS.md 和 README 中的架构说明。

## 风险与注意事项

### MV3 Service Worker 生命周期（最关键风险）

这是 MV3 项目后期最容易踩坑的地方。Service Worker 有以下硬性限制：

**所有内存状态随时可能丢失**。Service Worker 在空闲约 30 秒后可能被 Chrome 销毁，重启时所有内存变量重置。这意味着：

- `setInterval()` 不可靠——SW 休眠后定时器停止，必须用 `chrome.alarms` 替代（当前项目的弹幕定时刷新 `setInterval` 和关注轮询 `chrome.alarms` 混用，重构时应统一为 alarms）
- `Map()` 和 `Set()` 不可靠——`danmakuSessions`、`danmakuBatchBuffer`、`notifiedRooms`、`bestStreamsByRoom` 等数据结构在 SW 重启后变为空。必须确保关键状态已持久化到 `chrome.storage`，且 `restoreState()` 能完整重建
- `activeRecordingRoomUrl` 等运行时标记——如果 SW 在录制期间重启，该变量丢失。必须每次变更后立即持久化

**核心原则：所有关键状态必须视为可丢失状态。Service Worker 重启后应能够完全从 storage 重建运行状态。任何仅存储于内存 Map/Set 的数据都不应影响核心功能正确性。**

具体到本项目的影响：

| 状态 | 当前存储 | 风险等级 | 改进方案 |
|------|----------|----------|----------|
| `danmakuSessions` | 内存 Map | 高 | 每次会话变更时写入 storage.local |
| `danmakuBatchBuffer` | 内存 Map | 中 | 缓冲数据丢失可接受，但需记录缓冲状态 |
| `notifiedRooms` | 内存 Set + storage | 低 | 已有持久化，确保 restoreState 正确恢复 |
| `bestStreamsByRoom` | 内存 Map | 低 | 临时状态，丢失后重新检测即可 |
| `activeRecordingRoomUrl` | 内存 + storage | 高 | 已有持久化，确保每次变更立即写入 |
| `autoOpenedTabs` | 内存 Map | 中 | SW 重启后无法关闭已打开的标签页，可接受 |

### ⚠️ 弹幕高频定时器在 MV3 中的失效风险

**问题**：快手弹幕属于高频流，通常需要每 1~3 秒批量聚合发送一次 API。若在 Background 中依赖 `setInterval` 刷新 Buffer 发送给后端，由于 MV3 Service Worker 随时挂起，定时器会被直接停止；若改用 `chrome.alarms`，其最小周期为 1 分钟，根本无法满足弹幕实时同步的秒级需求。这是一个**致命冲突**——原代码中 `danmaku-session.js` 规划提到的"缓冲写入逻辑、定时刷新逻辑（批量发送）"如果放在 Background 运行，将导致弹幕数据严重延迟或丢失。

**对策**：

1. **前端聚合**：由 `content.js`（依托于网页端，天然不会休眠）维护 2~3 秒的弹幕数组，聚合后通过 `ACTIONS.DANMAKU_BATCH` 一次性打包发送给 Background。content.js 运行在活跃标签页中，`setInterval` 不会被挂起。
2. **后端消费**：Background 收到 Batch 消息后，**不进行任何内存等待**，直接通过 `lib/http.js` 转发给录制后端，或者利用"计数器满 X 条即触发"的无状态逻辑，彻底消灭 Background 中的秒级定时器。
3. **容错机制**：如果 SW 在收到 Batch 消息后被唤醒并处理，偶尔丢失少量弹幕缓冲数据是可接受的（弹幕本身是非关键数据）。但需要在日志中记录此类丢失事件，便于排查。

### MV3 路径限制

content_scripts 中的 JS 文件路径变更后，需要确保 Chrome 能正确加载。`chrome.runtime.getURL('inject.js')` 需同步更新为 `chrome.runtime.getURL('content/inject.js')`。

### ESM 限制

inject.js 运行在 MAIN world，不能使用 `import` 语句，必须保持 IIFE。content.js 在 ISOLATED world 也不能使用 ESM（manifest content_scripts 不支持 `type: module`），所以 content.js 中如需引用公共模块，要么通过 `chrome.runtime.sendMessage` 间接调用，要么将少量必要函数内联。当前 content.js 中的 `isLiveRoomPage()` 只有 4 行，直接内联即可，不需要引入 lib/。

### Service Worker 缓存

background.js 作为 ESM Service Worker，import 路径变更后需要重新加载扩展。这是正常的开发流程，不影响用户数据（storage 不受影响）。

### 测试策略

由于项目没有自动化测试，每个阶段完成后需要手动验证以下场景：扩展重载后状态恢复、关注列表轮询检测开播、webRequest 捕获直播流、content.js 捕获视频流、Popup 手动录制、弹幕采集开关联动、Options 配置保存。
