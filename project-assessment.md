# 项目评估与后续开发计划

## 当前状态

本项目是一个 Manifest V3 Chrome 扩展，无构建流程，代码由原生 ES Module 组成。核心能力包括：

1. 通过 `webRequest` 捕获 `.flv` 直播流。
2. 通过 `content.js` 轮询 `<video>.currentSrc` 补充捕获。
3. 通过快手关注开播接口统一轮询开播列表。
4. 按环境配置后端录制接口，并向匹配环境推送直播流。
5. 使用 `chrome.storage.sync` 保存用户配置，使用 `chrome.storage.local` 保存检测结果和运行状态。

整体实现足够轻量，适合个人或小范围使用。但目前运行状态、权限配置、错误处理和测试保障仍偏脆弱，后续要优先提高自动录制链路的确定性。

## 主要风险

### 高优先级

1. 开发环境接口缺少 host permission

`config.js` 默认开发环境使用 `http://localhost:3001/*`，但 `manifest.json` 只声明了 `http://localhost:1123/*`。在启用开发环境时，扩展页和 Service Worker 对 `:3001` 的跨域请求可能失败。

建议：在 `manifest.json` 增加 `http://localhost:3001/*`，或统一约束环境配置只能使用已声明权限内的地址。

2. `activeRecordingRoomUrl` 是全局单值

`background.js` 中只记录一个正在录制的直播间。只要任一启用环境仍在录制该房间，后续轮询会整体跳过快手开播接口。这会影响多环境、多主播场景：例如生产环境正在录制主播 A，开发环境关注的主播 B 可能不能及时触发检测。

建议：改为按环境和直播间维度保存录制状态，例如 `activeRecordingByEnv = { production: roomUrl }`，并在所有启用环境都不需要查询时才跳过快手接口。

3. 清晰度选择 debounce 是全局状态

`autoRecordTimer`、`bestUrl`、`currentBestLevel` 是全局变量。多个直播间、多个标签页或短时间内多个 `.flv` 请求并发出现时，可能互相覆盖，导致错误的流地址被推送到不对应的环境。

建议：按 `tabId` 或 `roomUrl` 维护独立的质量选择状态，例如 `bestStreamsByTabId`。

4. UI 使用 `innerHTML` 拼接外部数据

`popup.js` 会把流地址、标题、房间 URL 拼进 `innerHTML` 和 `data-*` 属性。`options.js` 也用 `innerHTML` 拼接配置字段。直播标题和 URL 都属于外部输入，可能破坏 DOM 属性，扩展页面上下文下风险更高。

建议：改为 `document.createElement()`、`textContent`、`dataset` 和显式赋值，避免把外部数据直接放进 HTML 字符串。

### 中优先级

1. 状态没有完整持久化

Service Worker 重启后，`detectedStreams`、`activeRecordingRoomUrl`、清晰度选择状态都会丢失。部分数据写入了 `chrome.storage.local`，但内存和存储之间没有统一的恢复策略。

建议：明确运行态模型，关键状态持久化，并在 Service Worker 启动时恢复。

2. 后端请求缺少超时和响应格式保护

`fetch()` 没有超时控制，且多处默认 `await res.json()`。后端无响应、返回非 JSON 或 204 时，会进入异常路径，日志信息也不够结构化。

建议：封装后端请求函数，加入 `AbortController` 超时、JSON 容错和统一日志。

3. 自动推送与手动推送行为不一致

后台自动推送会先查状态接口，Popup 手动推送直接 POST 到所有启用环境，不查状态，也不按环境关注列表过滤。

建议：复用同一套发送函数，并在 Popup 中增加环境选择或明确标注“发送到所有启用环境”。

4. `content.js` 使用 3 秒轮询作为 keepalive

周期性 `sendMessage` 可以提高 Service Worker 活跃概率，但 MV3 不保证长期保活。该机制还会带来重复消息，需要依赖全局 `lastUrl` 去重。

建议：把 keepalive 视为辅助机制，不把关键状态只放内存；同时对 content 消息按 tab/room 做去重。

5. storage 没有 schema version

目前靠 `getConfig()` 做兼容读取，没有显式版本号、迁移记录和数据校验。随着环境级配置继续扩展，兼容逻辑会变复杂。

建议：引入 `configVersion`，集中迁移旧配置，并清理废弃字段。

### 低优先级

1. `detectedStreams` 无上限

长时间运行后 `chrome.storage.local.streams` 可能持续增长。

建议：只保留最近 N 条，例如 100 条。

2. 日志噪音较多

调试日志直接散落在核心流程里，缺少统一开关。

建议：增加 `debug` 配置或封装 `logDebug()`。

3. README 不足

当前 README 只有项目名，缺少安装、权限、配置、后端接口、手动测试步骤。

建议：补充基本使用文档，降低以后回归验证成本。

## 下一步开发计划

### 第一阶段：修正运行可靠性

1. 补齐 `manifest.json` 中开发环境端口权限。
2. 封装后端请求，加入超时、JSON 容错和统一状态返回。
3. 将 `activeRecordingRoomUrl` 改为按环境记录。
4. 将清晰度选择状态改为按 `tabId` 或 `roomUrl` 隔离。

### 第二阶段：收敛数据模型

1. 为 storage 增加 `configVersion`。
2. 编写配置迁移函数，明确从全局关注列表迁移到环境级关注列表。
3. 统一 stream 对象结构，确保 `webRequest` 与 `content.js` 写入同一种数据。
4. 为 `detectedStreams` 设置容量上限。

### 第三阶段：UI 与安全加固

1. 改造 Popup 和 Options 的 DOM 渲染，移除外部数据 `innerHTML` 拼接。
2. Popup 手动推送增加环境选择，或明确展示当前会发送到哪些环境。
3. Options 页面增加配置校验，例如 URL 必填、格式检查、环境关注列表为空提示。

### 第四阶段：测试与文档

1. 补充 README：安装、配置、权限、后端接口、手动测试步骤。
2. 增加轻量级测试脚本，至少覆盖配置合并、环境筛选、流对象归一化。
3. 建立手动回归清单：扩展重载、关注列表查询、webRequest 捕获、content 捕获、Popup 手动推送。

## 建议优先处理的三个任务

1. 修复 `manifest.json` 的 `localhost:3001` 权限缺口。
2. 把 `activeRecordingRoomUrl` 和清晰度 debounce 改成按环境/房间/标签页隔离。
3. 移除 Popup 和 Options 中对外部数据的 `innerHTML` 拼接。

