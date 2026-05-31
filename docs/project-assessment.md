# 项目评估与后续开发计划

## 当前状态

本项目是一个 Manifest V3 Chrome 扩展，无构建流程，代码由原生 ES Module 组成。核心能力包括：

1. 通过 `webRequest` 捕获 `.flv` 直播流。
2. 通过 `content.js` 轮询 `<video>.currentSrc` 补充捕获。
3. 通过快手关注开播接口统一轮询开播列表。
4. 按环境配置后端录制接口，并向匹配环境推送直播流。
5. 使用 `chrome.storage.sync` 保存用户配置，使用 `chrome.storage.local` 保存检测结果和运行状态。

整体实现足够轻量，适合个人或小范围使用。但目前运行状态、权限配置、错误处理和测试保障仍偏脆弱，后续要优先提高自动录制链路的确定性。

## 本轮修复进展

已处理：

1. Options 只允许保存 manifest 已声明的默认 `baseUrl`，避免配置成扩展无权限访问的地址。
2. `activeRecordingRoomUrl` 保持全局单值，并持久化到 storage；这是有意的风控策略。
3. 清晰度选择 debounce 已改为按直播间隔离，避免多个直播间互相覆盖最佳流。
4. Popup 直播流卡片和 Options 环境卡片已改为 DOM API 渲染，不再把外部标题、URL、配置值直接拼进 `innerHTML`。
5. 后端请求已增加超时和 JSON 容错，关注列表请求也复用统一请求封装。
6. Popup 手动推送会先查后端状态，避免重复发送已在录制的直播间。
7. Service Worker 启动时恢复 `streams`、`notifiedRooms` 和 `activeRecordingRoomUrl`。
8. `detectedStreams` 已限制最多保留 100 条。
9. storage 已增加 `configVersion` 写入。
10. README 已补充安装、配置、接口和手动验证说明。

仍需后续处理：

1. 日志仍然比较分散，缺少可配置的 debug 开关。
2. Popup 手动推送还没有环境选择 UI，目前仍发送到所有启用环境。
3. 还没有自动化测试脚本，主要依赖 `node --check` 和手动验证。

## 主要风险

### 高优先级

1. 自定义 `baseUrl` 受 manifest 限制

`manifest.json` 已补齐默认的 `http://localhost:1123/*` 和 `http://localhost:3001/*`，Options 也已限制只能保存默认 `baseUrl`。如果以后新增环境或端口，需要同步更新 manifest 和默认配置。

建议：新增环境时先更新 manifest，再放开 Options 白名单。

2. `activeRecordingRoomUrl` 是全局单值

这是有意设计。当前只监控指定主播，且直播平台关注列表 API 风控严格；只要任一启用环境确认该主播仍在录制，就跳过整次关注列表查询，减少平台 API 请求。

后续如果扩展到多主播并发录制，再重新评估是否需要按主播或环境拆分。

3. 清晰度选择 debounce 是全局状态

已修复。当前按 `roomUrl` 保存清晰度选择状态，不同直播间互不覆盖。

后续可增加定时清理兜底，处理异常页面导致 timer 未执行的极端情况。

4. UI 使用 `innerHTML` 拼接外部数据

已修复主要风险。Popup 直播流卡片和 Options 环境卡片已改为 `document.createElement()`、`textContent`、`dataset` 和显式赋值。

后续继续避免新增 `innerHTML` 渲染外部数据。

### 中优先级

1. 状态持久化仍可继续完善

已恢复 `detectedStreams`、`notifiedRooms` 和 `activeRecordingRoomUrl`。清晰度 debounce 状态仍只保存在内存中，因为它是 2 秒内的临时选择状态。

建议：继续保持只持久化长期状态，临时状态不要写入 storage。

2. 后端请求缺少更细的错误展示

已增加请求超时和 JSON 容错。当前仍主要写 console，用户在 Popup 中看到的失败原因不够细。

建议：后续在 Popup 中展示按环境拆分的错误状态。

3. 自动推送与手动推送行为不一致

后台自动推送和 Popup 手动推送都会先查状态接口。Popup 仍没有环境选择，因此会发送到所有启用环境。

建议：Popup 增加环境选择或明确标注“发送到所有启用环境”。

4. `content.js` 使用 3 秒轮询作为 keepalive

周期性 `sendMessage` 可以提高 Service Worker 活跃概率，但 MV3 不保证长期保活。当前已限制只在 `/u/...` 直播间页上报 video 地址，避免关注页误报。

建议：把 keepalive 视为辅助机制，不把关键状态只放内存；同时对 content 消息按 tab/room 做去重。

5. storage 没有 schema version

已增加 `configVersion` 写入，但仍没有完整迁移器。随着环境级配置继续扩展，兼容逻辑会变复杂。

建议：引入 `configVersion`，集中迁移旧配置，并清理废弃字段。

### 低优先级

1. `detectedStreams` 无上限

已限制最多保留最近 100 条。

建议：后续可在 Options 中开放容量配置。

2. 日志噪音较多

调试日志直接散落在核心流程里，缺少统一开关。

建议：增加 `debug` 配置或封装 `logDebug()`。

3. README 不足

已补充安装、权限、配置、后端接口、手动测试步骤。

建议：随着后端接口变化持续同步 README。

## 下一步开发计划

### 第一阶段：修正运行可靠性

1. 已补齐 `manifest.json` 中开发环境端口权限。
2. 已封装后端请求，加入超时、JSON 容错和统一状态返回。
3. 已持久化 `activeRecordingRoomUrl`，并保留全局单直播间暂停轮询策略。
4. 已将清晰度选择状态改为按 `roomUrl` 隔离。

### 第二阶段：收敛数据模型

1. 已为 storage 增加 `configVersion`。
2. 待编写配置迁移函数，明确从全局关注列表迁移到环境级关注列表。
3. 已统一 stream 对象结构，确保 `webRequest` 与 `content.js` 写入同一种数据。
4. 已为 `detectedStreams` 设置容量上限。

### 第三阶段：UI 与安全加固

1. 已改造 Popup 和 Options 的 DOM 渲染，移除外部数据 `innerHTML` 拼接。
2. 待为 Popup 手动推送增加环境选择，或明确展示当前会发送到哪些环境。
3. 已为 Options 页面增加 Base URL 格式和权限校验；后续可增加关注列表为空提示。

### 第四阶段：测试与文档

1. 已补充 README：安装、配置、权限、后端接口、手动测试步骤。
2. 待增加轻量级测试脚本，至少覆盖配置合并、环境筛选、流对象归一化。
3. 待建立手动回归清单：扩展重载、关注列表查询、webRequest 捕获、content 捕获、Popup 手动推送。

## 建议优先处理的三个任务

1. 增加轻量级测试脚本，覆盖配置合并、环境筛选、流对象归一化。
2. Popup 增加环境选择或展示目标环境。
3. 增加 debug 日志开关，降低普通运行时的 console 噪音。
