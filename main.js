const {
  app,
  BrowserView,
  BrowserWindow,
  ipcMain,
  Menu,
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
const REPO_BASE_URL = "https://github.com/cp89cyber/Navigatr";
const RELOAD_ACCELERATORS = Object.freeze({
  reload: "CommandOrControl+R",
  forceReload: "Shift+CommandOrControl+R"
});
const ZOOM_ACCELERATORS = Object.freeze({
  actualSize: "CommandOrControl+0",
  zoomIn: "CommandOrControl+Plus",
  zoomOut: "CommandOrControl+-"
});
const ZOOM_DEFAULT_FACTOR = 1;
const ZOOM_MIN_FACTOR = 0.5;
const ZOOM_MAX_FACTOR = 3;
const ZOOM_STEP_MULTIPLIER = 1.2;
const ZOOM_FACTOR_PRECISION = 4;
const ZOOM_EPSILON = 1e-6;
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

function openHelpLink(targetUrl) {
  if (!targetUrl) return;
  void shell.openExternal(targetUrl);
}

function resolveTargetWindow(preferredWindow) {
  if (preferredWindow && !preferredWindow.isDestroyed()) {
    return preferredWindow;
  }

  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (focusedWindow && !focusedWindow.isDestroyed()) {
    return focusedWindow;
  }

  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) || null;
}

function getContextForWindow(win) {
  if (!win || win.isDestroyed()) return null;
  return windowContexts.get(win.webContents.id) || null;
}

function getLiveWindowWebContents(win) {
  if (!win) return null;

  try {
    if (win.isDestroyed()) return null;
    const wc = win.webContents;
    if (!wc || wc.isDestroyed()) return null;
    return wc;
  } catch (error) {
    if (String(error?.message || error).includes("Object has been destroyed")) {
      return null;
    }
    throw error;
  }
}

function getLiveViewWebContents(view) {
  if (!view) return null;

  try {
    const wc = view.webContents;
    if (!wc || wc.isDestroyed()) return null;
    return wc;
  } catch (error) {
    if (String(error?.message || error).includes("Object has been destroyed")) {
      return null;
    }
    throw error;
  }
}

function toggleDevToolsForWebContents(wc, mode = "detach") {
  if (!wc || wc.isDestroyed()) return;

  if (wc.isDevToolsOpened()) {
    wc.closeDevTools();
    return;
  }

  wc.openDevTools({ mode });
}

function togglePageDevTools(preferredWindow) {
  const targetWindow = resolveTargetWindow(preferredWindow);
  if (!targetWindow) return;

  const context = getContextForWindow(targetWindow);
  if (!context) return;

  toggleDevToolsForWebContents(context.view?.webContents);
}

function toggleAppUiDevTools(preferredWindow) {
  const targetWindow = resolveTargetWindow(preferredWindow);
  if (!targetWindow) return;

  toggleDevToolsForWebContents(targetWindow.webContents);
}

function reloadBrowserView(preferredWindow, { ignoreCache = false } = {}) {
  const targetWindow = resolveTargetWindow(preferredWindow);
  if (!targetWindow) return false;

  const context = getContextForWindow(targetWindow);
  if (!context) return false;

  const wc = context.view?.webContents;
  if (!wc || wc.isDestroyed()) return false;

  if (ignoreCache && typeof wc.reloadIgnoringCache === "function") {
    wc.reloadIgnoringCache();
    return true;
  }

  wc.reload();
  return true;
}

function roundZoomFactor(factor) {
  const precisionMultiplier = 10 ** ZOOM_FACTOR_PRECISION;
  return Math.round(factor * precisionMultiplier) / precisionMultiplier;
}

function clampZoomFactor(factor) {
  if (!Number.isFinite(factor) || factor <= 0) {
    return ZOOM_DEFAULT_FACTOR;
  }

  return roundZoomFactor(
    Math.min(ZOOM_MAX_FACTOR, Math.max(ZOOM_MIN_FACTOR, factor))
  );
}

function getBrowserViewWebContents(preferredWindow) {
  const targetWindow = resolveTargetWindow(preferredWindow);
  if (!targetWindow) return null;

  const context = getContextForWindow(targetWindow);
  if (!context) return null;

  const wc = context.view?.webContents;
  if (!wc || wc.isDestroyed()) return null;

  return wc;
}

function setBrowserViewZoomFactor(preferredWindow, factor) {
  const wc = getBrowserViewWebContents(preferredWindow);
  if (!wc) return false;

  wc.setZoomFactor(clampZoomFactor(factor));
  return true;
}

function adjustBrowserViewZoom(preferredWindow, direction) {
  const wc = getBrowserViewWebContents(preferredWindow);
  if (!wc) return false;

  const currentFactor = clampZoomFactor(wc.getZoomFactor());
  let nextFactor = NaN;

  if (direction === "in") {
    nextFactor = currentFactor * ZOOM_STEP_MULTIPLIER;
  } else if (direction === "out") {
    nextFactor = currentFactor / ZOOM_STEP_MULTIPLIER;
  } else {
    return false;
  }

  wc.setZoomFactor(clampZoomFactor(nextFactor));
  return true;
}

function lockAppUiZoom(win) {
  if (!win || win.isDestroyed()) return;

  const wc = win.webContents;
  if (!wc || wc.isDestroyed()) return;

  if (Math.abs(wc.getZoomFactor() - ZOOM_DEFAULT_FACTOR) <= ZOOM_EPSILON) {
    return;
  }

  wc.setZoomFactor(ZOOM_DEFAULT_FACTOR);
}

function handleLegacyReloadShortcut(event, input, preferredWindow) {
  if (process.platform === "darwin") return false;
  if (!input || input.type !== "keyDown") return false;

  const key = typeof input.key === "string" ? input.key.toLowerCase() : "";
  if (key !== "f5") return false;

  if (input.alt || input.meta || input.shift) {
    return false;
  }

  event.preventDefault();
  return reloadBrowserView(preferredWindow, { ignoreCache: Boolean(input.control) });
}

function buildAppMenu() {
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Reload",
          accelerator: RELOAD_ACCELERATORS.reload,
          click: (_menuItem, browserWindow) => {
            reloadBrowserView(browserWindow, { ignoreCache: false });
          }
        },
        {
          label: "Force Reload",
          accelerator: RELOAD_ACCELERATORS.forceReload,
          click: (_menuItem, browserWindow) => {
            reloadBrowserView(browserWindow, { ignoreCache: true });
          }
        },
        {
          label: "Toggle Developer Tools",
          accelerator:
            process.platform === "darwin" ? "Alt+Command+I" : "Ctrl+Shift+I",
          click: (_menuItem, browserWindow) => togglePageDevTools(browserWindow)
        },
        {
          label: "Toggle App UI Developer Tools",
          click: (_menuItem, browserWindow) => toggleAppUiDevTools(browserWindow)
        },
        { type: "separator" },
        {
          label: "Actual Size",
          accelerator: ZOOM_ACCELERATORS.actualSize,
          click: (_menuItem, browserWindow) => {
            setBrowserViewZoomFactor(browserWindow, ZOOM_DEFAULT_FACTOR);
          }
        },
        {
          label: "Zoom In",
          accelerator: ZOOM_ACCELERATORS.zoomIn,
          click: (_menuItem, browserWindow) => {
            adjustBrowserViewZoom(browserWindow, "in");
          }
        },
        {
          label: "Zoom Out",
          accelerator: ZOOM_ACCELERATORS.zoomOut,
          click: (_menuItem, browserWindow) => {
            adjustBrowserViewZoom(browserWindow, "out");
          }
        }
      ]
    },
    { role: "windowMenu" },
    {
      label: "Help",
      submenu: [
        {
          label: "Learn More",
          click: () => openHelpLink(REPO_BASE_URL)
        },
        {
          label: "Documentation",
          click: () => openHelpLink(`${REPO_BASE_URL}/blob/main/README.md`)
        },
        {
          label: "Community Discussions",
          click: () => openHelpLink(`${REPO_BASE_URL}/discussions`)
        },
        {
          label: "Search Issues",
          click: () => openHelpLink(`${REPO_BASE_URL}/issues`)
        }
      ]
    }
  ];

  return Menu.buildFromTemplate(template);
}

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
  if (!context || context.cleanedUp) return;
  context.cleanedUp = true;

  windowContexts.delete(context.rendererWebContentsId);
  const winWebContents = getLiveWindowWebContents(context.win);
  const viewWebContents = getLiveViewWebContents(context.view);

  if (typeof context.beforeInputHandler === "function" && winWebContents) {
    winWebContents.removeListener("before-input-event", context.beforeInputHandler);
  }

  if (typeof context.appUiZoomLockHandler === "function" && winWebContents) {
    winWebContents.removeListener("zoom-changed", context.appUiZoomLockHandler);
  }

  if (viewWebContents) {
    if (typeof context.beforeInputHandler === "function") {
      viewWebContents.removeListener("before-input-event", context.beforeInputHandler);
    }
    viewWebContents.removeAllListeners();
  }

  try {
    if (context.win && !context.win.isDestroyed()) {
      context.win.setBrowserView(null);
    }
  } catch (error) {
    if (!String(error?.message || error).includes("Object has been destroyed")) {
      throw error;
    }
  }

  if (viewWebContents) {
    viewWebContents.destroy();
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    fullscreenable: false,
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
    rendererWebContentsId: win.webContents.id,
    beforeInputHandler: null,
    appUiZoomLockHandler: null,
    cleanedUp: false
  };

  context.beforeInputHandler = (event, input) => {
    handleLegacyReloadShortcut(event, input, win);
  };
  context.appUiZoomLockHandler = (event) => {
    if (typeof event?.preventDefault === "function") {
      event.preventDefault();
    }
    lockAppUiZoom(win);
  };

  windowContexts.set(context.rendererWebContentsId, context);
  lockAppUiZoom(win);
  win.webContents.on("before-input-event", context.beforeInputHandler);
  win.webContents.on("zoom-changed", context.appUiZoomLockHandler);
  view.webContents.on("before-input-event", context.beforeInputHandler);
  registerViewHandlers(context);
  applyViewBounds(context);

  win.loadFile(path.join(__dirname, "index.html"));

  win.webContents.on("did-finish-load", () => {
    lockAppUiZoom(win);
    sendState(context);
  });

  win.on("resize", () => {
    applyViewBounds(context);
  });

  win.once("closed", () => {
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
  reloadBrowserView(context.win, { ignoreCache: false });
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
  Menu.setApplicationMenu(buildAppMenu());
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
