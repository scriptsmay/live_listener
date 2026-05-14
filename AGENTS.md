# Live Stream Sniffer — Chrome Extension

## Setup

No build, no bundler, no package manager. Load as unpacked extension in `chrome://extensions` (dev mode). After editing any JS/HTML file, reload the extension on that page.

## Architecture

- **Manifest V3** — service worker (`background.js`) is ESM (`type: "module"`).
- All files are plain ES modules that `import` from each other directly.
- **Entrypoints**: `background.js` (service worker), `popup.js` (popup UI), `options.js` (settings page), `content.js` (injected on `live.kuaishou.com`).
- Config lives in `config.js` — no env vars, no external config loading.
- User settings (`apiUrl` only) are persisted via `chrome.storage.sync`; detected streams use `chrome.storage.local`.

## Key constraints

- `host_permissions` limit to `*.kuaishou.com`, `*.yximgs.com`, `localhost:3000`, `localhost:1123`.
- Auto-record is hardcoded to trigger only when tab title includes `KSG无言` (`background.js:32`).
- Quality selection uses `QUALITY_WEIGHTS` from `config.js` with a 2-second debounce (`background.js:53`).
- Content script polls `<video>` elements every 3 seconds (`content.js:14`).
- Backend endpoint: `POST http://localhost:1123/api/notify/live_download` with JSON body `{ url, title, room_url }`.

## Testing

No test framework exists. Manual testing only: load extension, navigate to `live.kuaishou.com`, verify badge count and popup.

## Style

Plain JavaScript, no TypeScript, no formatter. Imports use full `.js` extensions. All comments and strings are in Chinese.
