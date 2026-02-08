const {
  app,
  BrowserView,
  BrowserWindow,
  ipcMain,
  session,
  shell,
  webContents
} = require("electron");
const path = require("path");
const {
  extractHostname,
  isBlockedHost,
  isSameSite
} = require("./adblock/matcher");
const { loadSettings, saveSettings } = require("./adblock/settings");
const { normalizeInput } = require("./url-input");

const adblockState = {
  enabled: true,
  blockedTotal: 0
};

function getAdblockState() {
  return {
    enabled: adblockState.enabled,
    blockedTotal: adblockState.blockedTotal
  };
}

function broadcastAdblock(channel) {
  const payload = getAdblockState();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

function setupAdblock() {
  adblockState.enabled = loadSettings().enabled;

  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ["*://*/*"] },
    (details, callback) => {
      if (!adblockState.enabled) {
        callback({ cancel: false });
        return;
      }

      if (!/^https?:/i.test(details.url)) {
        callback({ cancel: false });
        return;
      }

      if (details.resourceType === "mainFrame") {
        callback({ cancel: false });
        return;
      }

      const requestHost = extractHostname(details.url);
      if (!requestHost || !isBlockedHost(requestHost)) {
        callback({ cancel: false });
        return;
      }

      let initiatorHost = extractHostname(details.initiator || details.referrer);
      if (!initiatorHost && Number.isInteger(details.webContentsId)) {
        const sourceContents = webContents.fromId(details.webContentsId);
        initiatorHost = extractHostname(sourceContents?.getURL());
      }

      if (!initiatorHost || isSameSite(requestHost, initiatorHost)) {
        callback({ cancel: false });
        return;
      }

      adblockState.blockedTotal += 1;
      broadcastAdblock("adblock:stats");
      callback({ cancel: true });
    }
  );

  ipcMain.handle("adblock:get-state", () => getAdblockState());
  ipcMain.handle("adblock:set-enabled", (_event, enabled) => {
    adblockState.enabled = Boolean(enabled);
    saveSettings({ enabled: adblockState.enabled });
    broadcastAdblock("adblock:state");
    return { enabled: adblockState.enabled };
  });
}

const DEFAULT_URL = "https://example.com";
const SEARCH_URL = "https://duckduckgo.com/?q=";
const IPC_CHANNELS = Object.freeze({
  navigate: "browser:navigate",
  back: "browser:back",
  forward: "browser:forward",
  reload: "browser:reload",
  setToolbarHeight: "browser:set-toolbar-height",
  getState: "browser:get-state",
  state: "browser:state"
});

const windowContexts = new Map();

const AUTHORITY_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const INTERNAL_SCHEMES = new Set(["http", "https", "about", "blob", "data"]);
const NON_AUTHORITY_EXTERNAL_SCHEMES = new Set(["mailto", "tel", "sms"]);

function getScheme(targetUrl) {
  const match = SCHEME_RE.exec(targetUrl);
  return match ? match[0].slice(0, -1).toLowerCase() : null;
}

function isExternalProtocol(targetUrl) {
  const scheme = getScheme(targetUrl);
  if (!scheme) return false;
  if (INTERNAL_SCHEMES.has(scheme)) return false;
  if (AUTHORITY_SCHEME_RE.test(targetUrl)) return true;
  return NON_AUTHORITY_EXTERNAL_SCHEMES.has(scheme);
}

function allowInPageNavigation(context, targetUrl) {
  const scheme = getScheme(targetUrl);
  if (!scheme) return false;
  if (scheme === "about" || scheme === "data") return true;
  if (scheme !== "blob") return false;

  try {
    const targetOrigin = new URL(targetUrl).origin;
    const currentOrigin = new URL(context.view.webContents.getURL()).origin;
    return (
      targetOrigin !== "null" &&
      currentOrigin !== "null" &&
      targetOrigin === currentOrigin
    );
  } catch {
    return false;
  }
}

function buildState(context) {
  const wc = context.view.webContents;
  return {
    url: wc.getURL() || "",
    canGoBack: canGoBack(wc),
    canGoForward: canGoForward(wc),
    isLoading: wc.isLoading(),
    status: context.status,
    title: wc.getTitle() || ""
  };
}

function canGoBack(wc) {
  return wc.navigationHistory?.canGoBack
    ? wc.navigationHistory.canGoBack()
    : wc.canGoBack();
}

function canGoForward(wc) {
  return wc.navigationHistory?.canGoForward
    ? wc.navigationHistory.canGoForward()
    : wc.canGoForward();
}

function goBack(wc) {
  if (wc.navigationHistory?.goBack) {
    wc.navigationHistory.goBack();
    return;
  }
  wc.goBack();
}

function goForward(wc) {
  if (wc.navigationHistory?.goForward) {
    wc.navigationHistory.goForward();
    return;
  }
  wc.goForward();
}

function sendState(context) {
  if (context.win.isDestroyed()) return;
  context.win.webContents.send(IPC_CHANNELS.state, buildState(context));
}

function applyViewBounds(context) {
  if (context.win.isDestroyed()) return;

  const [width, height] = context.win.getContentSize();
  const toolbarHeight = Math.max(0, Math.round(context.toolbarHeight || 0));
  const viewHeight = Math.max(0, height - toolbarHeight);

  context.view.setBounds({
    x: 0,
    y: toolbarHeight,
    width: Math.max(0, width),
    height: viewHeight
  });
  context.view.setAutoResize({ width: true, height: true });
}

async function openExternalUrl(context, targetUrl) {
  try {
    await shell.openExternal(targetUrl);
    context.status = "Opened external link in system app";
  } catch (error) {
    context.status = `Error: ${error?.message || "Unable to open external link"}`;
  }
  sendState(context);
}

async function loadInView(context, targetUrl) {
  try {
    await context.view.webContents.loadURL(targetUrl);
  } catch (error) {
    context.status = `Error: ${error?.message || "Failed to load"}`;
    sendState(context);
  }
}

function navigateInput(context, rawInput) {
  const targetUrl = normalizeInput(rawInput, { searchUrl: SEARCH_URL });
  if (!targetUrl) return;

  if (isExternalProtocol(targetUrl)) {
    void openExternalUrl(context, targetUrl);
    return;
  }

  void loadInView(context, targetUrl);
}

function registerViewHandlers(context) {
  const wc = context.view.webContents;

  wc.on("did-start-loading", () => {
    context.status = "Loading...";
    sendState(context);
  });

  wc.on("did-stop-loading", () => {
    context.status = "Done";
    sendState(context);
  });

  wc.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (isMainFrame === false || errorCode === -3) return;
      context.status = `Error: ${errorDescription || "Failed to load"}`;
      sendState(context);
    }
  );

  wc.on("page-title-updated", () => {
    sendState(context);
  });

  wc.on("did-navigate", () => {
    sendState(context);
  });

  wc.on("did-navigate-in-page", () => {
    sendState(context);
  });

  wc.on("will-navigate", (event, targetUrl) => {
    if (allowInPageNavigation(context, targetUrl)) return;
    if (!isExternalProtocol(targetUrl)) return;
    event.preventDefault();
    void openExternalUrl(context, targetUrl);
  });

  wc.setWindowOpenHandler(({ url }) => {
    if (!url) return { action: "deny" };

    if (allowInPageNavigation(context, url)) {
      void loadInView(context, url);
      return { action: "deny" };
    }

    if (isExternalProtocol(url)) {
      void openExternalUrl(context, url);
      return { action: "deny" };
    }

    void loadInView(context, url);
    return { action: "deny" };
  });
}

function getContextFromEvent(event) {
  return windowContexts.get(event.sender.id) || null;
}

function cleanupWindowContext(context) {
  windowContexts.delete(context.rendererWebContentsId);

  if (!context.view.webContents.isDestroyed()) {
    context.view.webContents.removeAllListeners();
  }

  if (!context.win.isDestroyed()) {
    context.win.setBrowserView(null);
  }

  if (!context.view.webContents.isDestroyed()) {
    context.view.webContents.destroy();
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const view = new BrowserView();
  win.setBrowserView(view);

  const context = {
    win,
    view,
    status: "Ready",
    toolbarHeight: 48,
    rendererWebContentsId: win.webContents.id
  };

  windowContexts.set(context.rendererWebContentsId, context);
  registerViewHandlers(context);
  applyViewBounds(context);

  win.loadFile(path.join(__dirname, "index.html"));

  win.webContents.on("did-finish-load", () => {
    sendState(context);
  });

  win.on("resize", () => {
    applyViewBounds(context);
  });

  win.on("closed", () => {
    cleanupWindowContext(context);
  });

  void loadInView(context, DEFAULT_URL);
}

ipcMain.handle(IPC_CHANNELS.navigate, (event, rawInput) => {
  const context = getContextFromEvent(event);
  if (!context) return null;
  navigateInput(context, rawInput);
  return buildState(context);
});

ipcMain.handle(IPC_CHANNELS.back, (event) => {
  const context = getContextFromEvent(event);
  if (!context) return null;
  if (canGoBack(context.view.webContents)) {
    goBack(context.view.webContents);
  }
  return buildState(context);
});

ipcMain.handle(IPC_CHANNELS.forward, (event) => {
  const context = getContextFromEvent(event);
  if (!context) return null;
  if (canGoForward(context.view.webContents)) {
    goForward(context.view.webContents);
  }
  return buildState(context);
});

ipcMain.handle(IPC_CHANNELS.reload, (event) => {
  const context = getContextFromEvent(event);
  if (!context) return null;
  context.view.webContents.reload();
  return buildState(context);
});

ipcMain.handle(IPC_CHANNELS.setToolbarHeight, (event, px) => {
  const context = getContextFromEvent(event);
  if (!context) return null;

  const nextHeight = Number(px);
  if (Number.isFinite(nextHeight)) {
    context.toolbarHeight = Math.max(0, Math.round(nextHeight));
    applyViewBounds(context);
  }

  return buildState(context);
});

ipcMain.handle(IPC_CHANNELS.getState, (event) => {
  const context = getContextFromEvent(event);
  if (!context) return null;
  return buildState(context);
});

app.whenReady().then(() => {
  setupAdblock();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
