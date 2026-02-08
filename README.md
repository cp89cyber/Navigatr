# Navigatr

Extremely basic desktop web browser built with Electron.

## Run

```bash
npm install
npm start
```

## Smoke Test

```bash
npm run smoke:playwright
```

## Features

- URL bar
- Back / Forward / Reload controls
- Loads pages in a main-process `BrowserView` (no renderer `<webview>`)
- Popup/new-window requests are reused in the current view
- Non-HTTP(S) links (for example `mailto:`) open via the OS handler
alternative web browser
