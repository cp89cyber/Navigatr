# Navigatr

Extremely basic desktop web browser built with Electron.

## Run

```bash
npm install
npm start
```

## Test

```bash
npm test
```

## Features

- URL bar
- Back / Forward / Reload controls
- Loads pages in an embedded browser view
- Built-in ad/tracker domain blocklist
- Network-level third-party request blocking
- Toolbar ad-block toggle with blocked-request counter
- Persisted ad-block enabled setting across restarts

## Scope Notes

- Blocking is network-only (no cosmetic DOM filtering).
- Uses a built-in starter domain list (no remote list downloads).
- Applies third-party blocking only; first-party/main-frame requests are allowed.
- Per-site allowlists are not implemented in this version.
