const { app, BrowserWindow, ipcMain, session, webContents } = require("electron");
const path = require("path");
const {
  extractHostname,
  isBlockedHost,
  isSameSite
} = require("./adblock/matcher");
const { loadSettings, saveSettings } = require("./adblock/settings");

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

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, "index.html"));
}

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
