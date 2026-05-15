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
- `config.js` defines two built-in environments:
  - `production` → `localhost:1123`
  - `development` → `localhost:3001`
  - Settings page has a dropdown to switch; URL fields auto-fill when env changes.
- `getConfig()` returns `{ env, notifyApiUrl, statusApiUrl, followedAuthors }`. Falls back to old `apiUrl` storage key for backward compatibility.

## Testing

No test framework exists. Manual testing only: load extension, navigate to `live.kuaishou.com`, verify badge count and popup.

## Style

Plain JavaScript, no TypeScript, no formatter. Imports use full `.js` extensions. All comments and strings are in Chinese.
