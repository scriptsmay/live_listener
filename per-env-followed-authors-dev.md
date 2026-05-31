# 按环境配置关注主播改造开发文档

## 需求理解

当前扩展支持多个后端环境，每个环境可以独立配置启用状态、录制接口和状态查询接口，但“关注的主播”仍是全局共享配置。目标是将关注主播列表下沉到每个环境中单独配置。

开播数据请求仍然保持统一：扩展只请求一次快手关注开播接口，拿到开播列表后，再根据每个已启用环境自己的关注主播列表进行过滤。匹配到某个环境关注的主播后，只向该环境对应的后端推送直播流。

## 改造目标

1. `options.html` 中每个环境卡片内增加“关注的主播”配置。
2. 移除或废弃全局共享的关注主播输入框。
3. `chrome.storage.sync.environments` 中每个环境保存自己的 `followedAuthors`。
4. `getConfig()` 返回的环境对象包含 `followedAuthors`。
5. 兼容旧配置：如果旧版本存在全局 `followedAuthors`，首次读取时作为环境默认关注列表使用。
6. 快手开播列表请求仍只发一次，不因为多个环境重复请求。
7. 推送录制请求时按环境过滤，只推送到匹配该环境关注列表的后端。

## 数据结构

### 当前结构

```js
{
  environments: [
    {
      name: 'production',
      label: '生产环境',
      enabled: true,
      notifyApiUrl: 'http://localhost:1123/api/notify/live_download',
      statusApiUrl: 'http://localhost:1123/api/notify/status'
    }
  ],
  followedAuthors: ['KSG无言']
}
```

### 目标结构

```js
{
  environments: [
    {
      name: 'production',
      label: '生产环境',
      enabled: true,
      notifyApiUrl: 'http://localhost:1123/api/notify/live_download',
      statusApiUrl: 'http://localhost:1123/api/notify/status',
      followedAuthors: ['KSG无言']
    },
    {
      name: 'development',
      label: '开发环境',
      enabled: false,
      notifyApiUrl: 'http://localhost:3001/api/notify/live_download',
      statusApiUrl: 'http://localhost:3001/api/notify/status',
      followedAuthors: []
    }
  ]
}
```

`followedAuthors` 继续使用字符串数组，每个主播名精确匹配快手 API 返回的 `author.name`。从页面标题捕获流地址时，仍使用 `tab.title.includes(authorName)` 做包含匹配。

## 配置读取策略

`config.js` 中 `DEFAULT_ENVIRONMENTS` 需要为每个环境增加默认 `followedAuthors` 字段：

```js
followedAuthors: ['KSG无言']
```

`getConfig()` 合并配置时按以下优先级处理：

1. 使用环境级 `stored.followedAuthors`，如果存在。
2. 否则使用旧全局 `storage.followedAuthors`，如果存在。
3. 否则使用默认环境的 `def.followedAuthors`。
4. 最后兜底为空数组。

返回结构建议保持：

```js
{
  environments
}
```

短期也可以继续返回全局 `followedAuthors` 作为兼容字段，但新代码不再依赖它。

## Options 页面改造

每个环境卡片内新增 textarea：

```html
<div class="env-field">
  <label>关注的主播（每行一个）</label>
  <textarea class="env-followed-authors" rows="5" placeholder="KSG无言"></textarea>
</div>
```

`options.js` 的处理逻辑：

1. `renderEnvCard(env)` 渲染环境级主播列表。
2. `getEnvData(env, card)` 读取该卡片内的 textarea，并转成数组：

```js
const followedAuthors = card
  .querySelector('.env-followed-authors')
  .value.split('\n')
  .map((s) => s.trim())
  .filter(Boolean);
```

3. 保存时只写入 `environments`。
4. 为兼容旧数据，可以保存后删除旧的全局 `followedAuthors`：

```js
chrome.storage.sync.remove('followedAuthors');
```

也可以保留旧字段不再读取，避免对历史数据做破坏性清理。推荐首版保留旧字段，仅 `getConfig()` 不再优先依赖它。

## 后台推送流程改造

### 现有问题

当前 `checkFollowingLivings()` 逻辑是：

1. 读取全局 `config.followedAuthors`。
2. 请求一次 `LIVING_API_URL`。
3. 找到匹配主播后调用 `handleStreamerOnline()`。
4. `handleStreamerOnline()` 调用 `sendToBackend()`。
5. `sendToBackend()` 遍历所有启用环境并推送。

这会导致一个环境关注的主播被推送到所有启用环境。

### 目标流程

目标流程是：

1. 读取配置。
2. 取所有已启用环境的关注主播合集。
3. 如果合集为空，直接返回。
4. 请求一次 `LIVING_API_URL`。
5. 遍历开播列表。
6. 对每个开播主播，找出关注该主播的启用环境。
7. 只对匹配环境发送录制请求。

示意：

```js
const enabledEnvs = config.environments.filter((env) => env.enabled);
const allAuthors = new Set(
  enabledEnvs.flatMap((env) => env.followedAuthors || [])
);

if (!allAuthors.size) return;

const matchedEnvs = enabledEnvs.filter((env) =>
  (env.followedAuthors || []).includes(author.name)
);
```

## 函数拆分建议

为了让职责清晰，建议调整为以下结构：

```js
async function sendToBackend(url, title, roomUrl, caption = '', targetEnvs = null)
```

`targetEnvs` 为空时保持旧行为：推送到所有启用环境。这样手动推送、webRequest 捕获和 content 捕获都可以逐步迁移。

也可以新增更明确的函数：

```js
async function sendToEnvironments(environments, url, title, roomUrl, caption = '')
```

推荐方案：新增 `sendToEnvironments()`，让 `sendToBackend()` 只做兼容包装，减少参数含义混乱。

## 开播轮询匹配逻辑

`checkFollowingLivings()` 应该改成环境级匹配：

```js
const config = await getConfig();
const enabledEnvs = config.environments.filter((env) => env.enabled);
const followedNames = new Set(
  enabledEnvs.flatMap((env) => env.followedAuthors || [])
);

if (!followedNames.size) return;
```

遍历接口返回列表时：

```js
const targetEnvs = enabledEnvs.filter((env) =>
  (env.followedAuthors || []).includes(author.name)
);

if (targetEnvs.length) {
  handleStreamerOnline(author, item.id, item.playUrls || [], item.caption, targetEnvs);
}
```

`handleStreamerOnline()` 增加 `targetEnvs` 参数，并将它传给推送函数。

## webRequest 与 content 捕获匹配逻辑

这两条链路没有快手关注接口返回的 `author.name`，只能根据页面标题匹配。需要按环境分别判断：

```js
const targetEnvs = config.environments.filter((env) => {
  if (!env.enabled) return false;
  return (env.followedAuthors || []).some((name) => tab.title.includes(name));
});
```

匹配到多个环境时，自动录制只向这些环境推送。

`autoChooseBest()` 当前内部调用 `sendToBackend(bestUrl, tab.title, roomUrl)`，需要能接收并保留 `targetEnvs`，避免 2 秒 debounce 后丢失环境上下文。

## 状态查询与录制中跳过策略

当前 `activeRecordingRoomUrl` 是全局单值，并且轮询前只要任一环境仍在录制，就跳过快手开播列表请求。

环境级关注改造后，这里需要谨慎处理。首版可以保留当前策略，因为需求明确“关注列表的请求是统一发出的”，且现有逻辑本来就是全局跳过。但它有一个副作用：生产环境正在录制 A 时，开发环境关注的 B 开播可能不会被及时查询到。

更合理的后续方案：

```js
const activeRecordingRoomUrlsByEnv = {
  production: 'https://live.kuaishou.com/u/xxx',
  development: null
}
```

轮询前分别检查各环境状态，只在所有启用环境都处于仍在录制且无需查询时才跳过快手请求。该优化可以作为第二阶段，避免扩大本次改造范围。

## 通知与去重

`notifiedRooms` 当前按 `roomId` 去重。环境级推送后，如果同一个主播同时被多个环境关注，只应创建一条 Chrome 通知即可，推送请求则分别发给多个环境。

推荐保持 `notifiedRooms` 逻辑不变。

## Popup 手动推送

Popup 中点击“开始录制”当前会推送到所有启用环境。环境级关注不一定要求修改手动推送行为。

建议保持手动推送为“所有启用环境”，因为用户点击按钮时没有选择环境。后续如需更精细，可以在 Popup 中增加环境选择。

## 兼容与迁移

无需一次性迁移 storage 数据。通过 `getConfig()` 做读取兼容即可。

兼容场景：

1. 新用户：使用 `DEFAULT_ENVIRONMENTS[*].followedAuthors`。
2. 老用户：旧的全局 `followedAuthors` 自动作为每个环境的默认关注列表。
3. 老用户保存 options 后：每个环境写入自己的 `followedAuthors`，之后以环境级配置为准。

## 手动测试用例

1. 打开 options 页面，确认每个环境都有独立主播 textarea。
2. 生产环境填写 `主播A`，开发环境填写 `主播B`，保存后重新打开页面，确认配置持久化。
3. 仅启用生产环境，模拟或等待 `主播A` 开播，确认只请求一次快手开播接口，并只推送生产后端。
4. 同时启用生产和开发，两个环境都关注 `主播A`，确认只请求一次快手接口，但两个后端都会收到推送。
5. 生产关注 `主播A`、开发关注 `主播B`，`主播A` 开播时只推送生产后端。
6. 页面标题捕获 `.flv` 时，确认只向标题匹配的环境推送。
7. 旧 storage 中只有全局 `followedAuthors` 时，确认 options 首次加载能自动带入每个环境。

## 实施顺序

1. 修改 `config.js`：为环境增加默认 `followedAuthors`，调整 `getConfig()` 合并逻辑。
2. 修改 `options.html`：删除全局关注区域，在环境卡片样式中支持 textarea。
3. 修改 `options.js`：渲染、读取、保存环境级主播列表。
4. 修改 `background.js`：新增按目标环境推送函数，改造轮询、webRequest、content 三条自动录制链路。
5. 手动加载扩展并验证配置保存与推送过滤。

