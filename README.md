# Navigatr

Extremely basic desktop web browser built with Electron.

## Run

```bash
npm install
npm start
```

## Tests

```bash
npm test
npm run smoke:playwright
```

## Features

- URL bar
- Back / Forward / Reload controls
- Loads pages in a main-process `BrowserView` (no renderer `<webview>`)
- Popup/new-window requests are reused in the current view
- Non-HTTP(S) links (for example `mailto:`) open via the OS handler
- Built-in ad/tracker domain blocklist
- Network-level third-party request blocking
- Toolbar ad-block toggle with blocked-request counter
- Persisted ad-block enabled setting across restarts

## Scope Notes

- Blocking is network-only (no cosmetic DOM filtering).
- Uses a built-in starter domain list (no remote list downloads).
- Applies third-party blocking only; first-party/main-frame requests are allowed.
- Per-site allowlists are not implemented in this version.
