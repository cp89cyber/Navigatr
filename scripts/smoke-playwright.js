#!/usr/bin/env node
"use strict";

const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");

const electronBinary = require("electron");
const { _electron: electron } = require("playwright");

const HOST = "127.0.0.1";
const WATCHDOG_TIMEOUT_MS = readPositiveIntEnv("SMOKE_WATCHDOG_TIMEOUT_MS", 120000);
const ELECTRON_CLOSE_TIMEOUT_MS = readPositiveIntEnv("SMOKE_ELECTRON_CLOSE_TIMEOUT_MS", 5000);
const ELECTRON_KILL_WAIT_TIMEOUT_MS = readPositiveIntEnv(
  "SMOKE_ELECTRON_KILL_WAIT_TIMEOUT_MS",
  3000
);
const FIXTURE_CLOSE_TIMEOUT_MS = readPositiveIntEnv("SMOKE_FIXTURE_CLOSE_TIMEOUT_MS", 4000);
const FIXTURE_FORCE_CLOSE_TIMEOUT_MS = readPositiveIntEnv(
  "SMOKE_FIXTURE_FORCE_CLOSE_TIMEOUT_MS",
  2000
);

function readPositiveIntEnv(name, fallbackMs) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallbackMs;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms: ${label}`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function waitForCondition(check, label, timeoutMs = 10000, intervalMs = 100) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const value = await check();
    if (value) return value;
    await delay(intervalMs);
  }

  throw new Error(`Timed out waiting for ${label}`);
}

async function startFixtureServer() {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${HOST}`);

    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
  <head><title>Fixture Home</title></head>
  <body>
    <h1>Home</h1>
    <a href="/second" id="to-second">Second</a>
    <a href="/popup" target="_blank" id="popup-link">Popup</a>
  </body>
</html>`);
      return;
    }

    if (url.pathname === "/second") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
  <head><title>Fixture Second</title></head>
  <body><h1>Second</h1></body>
</html>`);
      return;
    }

    if (url.pathname === "/popup") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
  <head><title>Fixture Popup</title></head>
  <body><h1>Popup</h1></body>
</html>`);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  await new Promise((resolve, reject) => {
    server.listen(0, HOST, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine fixture server port");
  }

  return {
    server,
    sockets,
    baseUrl: `http://${HOST}:${address.port}`
  };
}

async function stopFixtureServer(server, sockets = new Set()) {
  if (!server) return;
  const closePromise = new Promise((resolve) => {
    server.close(() => resolve());
  });

  try {
    await withTimeout(closePromise, FIXTURE_CLOSE_TIMEOUT_MS, "fixture server close");
    log("Fixture server closed");
    return;
  } catch (error) {
    log(`${error.message}; destroying lingering fixture sockets (${sockets.size})`);
    for (const socket of sockets) {
      socket.destroy();
    }
  }

  try {
    await withTimeout(
      closePromise,
      FIXTURE_FORCE_CLOSE_TIMEOUT_MS,
      "fixture server forced close"
    );
    log("Fixture server closed after destroying lingering sockets");
  } catch (error) {
    log(`${error.message}; continuing teardown`);
  }
}

function getActiveHandleNames() {
  if (typeof process._getActiveHandles !== "function") return [];
  return process
    ._getActiveHandles()
    .map((handle) => handle?.constructor?.name || "UnknownHandle");
}

function shouldForceExit() {
  const override = process.env.SMOKE_FORCE_EXIT;
  if (override === "1") return true;
  if (override === "0") return false;
  return Boolean(process.env.CI);
}

function finalizeAndExit(exitCode) {
  const handleNames = getActiveHandleNames();
  if (handleNames.length > 0) {
    log(`Finalizing with exit code ${exitCode}; active handles: ${handleNames.join(", ")}`);
  } else {
    log(`Finalizing with exit code ${exitCode}; active handles: none`);
  }

  if (shouldForceExit()) {
    log(`Forcing process exit (SMOKE_FORCE_EXIT=${process.env.SMOKE_FORCE_EXIT || "auto"})`);
    process.exit(exitCode);
  }

  process.exitCode = exitCode;
}

function startWatchdog() {
  return setTimeout(() => {
    const handleNames = getActiveHandleNames();
    process.stderr.write(
      `[smoke] FAILED: global watchdog timed out after ${WATCHDOG_TIMEOUT_MS}ms\n`
    );
    if (handleNames.length > 0) {
      process.stderr.write(`[smoke] Active handles: ${handleNames.join(", ")}\n`);
    }
    process.exit(1);
  }, WATCHDOG_TIMEOUT_MS);
}

async function waitForProcessExit(childProcess, timeoutMs) {
  if (!childProcess || childProcess.exitCode !== null || childProcess.killed) return;

  await withTimeout(
    new Promise((resolve) => {
      const onExit = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        childProcess.off("exit", onExit);
        childProcess.off("error", onError);
      };

      childProcess.on("exit", onExit);
      childProcess.on("error", onError);
    }),
    timeoutMs,
    "electron process exit"
  );
}

async function closeElectronApp(electronApp) {
  if (!electronApp) return;

  let electronProcess = null;
  try {
    electronProcess = electronApp.process();
  } catch {
    // Best effort: fall through to close() timeout handling.
  }

  try {
    await withTimeout(electronApp.close(), ELECTRON_CLOSE_TIMEOUT_MS, "electronApp.close()");
    log("Electron app closed gracefully");
    return;
  } catch (error) {
    log(`${error.message}; attempting SIGKILL fallback`);
  }

  if (!electronProcess) {
    log("Electron process handle unavailable; skipping force kill");
    return;
  }

  if (electronProcess.exitCode !== null || electronProcess.killed) {
    log("Electron process already exited");
    return;
  }

  try {
    electronProcess.kill("SIGKILL");
    log("Sent SIGKILL to Electron process");
  } catch (error) {
    log(`Failed to SIGKILL Electron process: ${error?.message || error}`);
    return;
  }

  try {
    await waitForProcessExit(electronProcess, ELECTRON_KILL_WAIT_TIMEOUT_MS);
    log("Electron process exited after SIGKILL");
  } catch (error) {
    log(`${error.message}; continuing teardown`);
  }
}

async function getViewState(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return null;

    const view = win.getBrowserView();
    if (!view) return null;

    const wc = view.webContents;
    const history = wc.navigationHistory;

    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: history?.canGoBack ? history.canGoBack() : wc.canGoBack(),
      canGoForward: history?.canGoForward ? history.canGoForward() : wc.canGoForward(),
      windowCount: BrowserWindow.getAllWindows().length
    };
  });
}

async function waitForViewUrl(electronApp, matcher, label) {
  return waitForCondition(async () => {
    const state = await getViewState(electronApp);
    if (!state) return null;
    return matcher(state.url) ? state : null;
  }, label, 15000, 100);
}

async function waitForStatus(page, matcher, label) {
  return waitForCondition(async () => {
    const text = ((await page.textContent("#status")) || "").trim();
    return matcher(text) ? text : null;
  }, label, 15000, 100);
}

function log(message) {
  process.stdout.write(`[smoke] ${message}\n`);
}

async function navigateWithToolbar(page, targetUrl) {
  await page.fill("#url", targetUrl);
  await page.press("#url", "Enter");
}

async function findRendererWindow(electronApp) {
  await electronApp.firstWindow();

  return waitForCondition(async () => {
    const windows = electronApp.windows();

    for (const candidate of windows) {
      try {
        const toolbarCount = await candidate.locator("#toolbar").count();
        if (toolbarCount > 0) {
          return candidate;
        }
      } catch {
        // Ignore windows that are not ready/accessible yet.
      }
    }

    return null;
  }, "renderer window with toolbar", 30000, 150);
}

async function getMenuViewState(electronApp) {
  return electronApp.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    if (!menu) {
      return {
        hasToggleFullscreenRole: false,
        hasF11Accelerator: false,
        hasGenericToggleDevToolsRole: false,
        hasGenericResetZoomRole: false,
        hasGenericZoomInRole: false,
        hasGenericZoomOutRole: false,
        hasToggleDevToolsLabel: false,
        hasToggleAppUiDevToolsLabel: false,
        hasActualSizeLabel: false,
        hasZoomInLabel: false,
        hasZoomOutLabel: false
      };
    }

    const queue = [...menu.items];
    let hasToggleFullscreenRole = false;
    let hasF11Accelerator = false;
    let hasGenericToggleDevToolsRole = false;
    let hasGenericResetZoomRole = false;
    let hasGenericZoomInRole = false;
    let hasGenericZoomOutRole = false;
    let hasToggleDevToolsLabel = false;
    let hasToggleAppUiDevToolsLabel = false;
    let hasActualSizeLabel = false;
    let hasZoomInLabel = false;
    let hasZoomOutLabel = false;

    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) continue;

      const role = typeof item.role === "string" ? item.role.toLowerCase() : "";
      if (role === "togglefullscreen") {
        hasToggleFullscreenRole = true;
      }
      if (role === "toggledevtools") {
        hasGenericToggleDevToolsRole = true;
      }
      if (role === "resetzoom") {
        hasGenericResetZoomRole = true;
      }
      if (role === "zoomin") {
        hasGenericZoomInRole = true;
      }
      if (role === "zoomout") {
        hasGenericZoomOutRole = true;
      }

      if (item.label === "Toggle Developer Tools") {
        hasToggleDevToolsLabel = true;
      }
      if (item.label === "Toggle App UI Developer Tools") {
        hasToggleAppUiDevToolsLabel = true;
      }
      if (item.label === "Actual Size") {
        hasActualSizeLabel = true;
      }
      if (item.label === "Zoom In") {
        hasZoomInLabel = true;
      }
      if (item.label === "Zoom Out") {
        hasZoomOutLabel = true;
      }

      const accelerator =
        typeof item.accelerator === "string" ? item.accelerator.toLowerCase() : "";
      if (accelerator.split("+").includes("f11")) {
        hasF11Accelerator = true;
      }

      if (item.submenu?.items?.length) {
        queue.push(...item.submenu.items);
      }
    }

    return {
      hasToggleFullscreenRole,
      hasF11Accelerator,
      hasGenericToggleDevToolsRole,
      hasGenericResetZoomRole,
      hasGenericZoomInRole,
      hasGenericZoomOutRole,
      hasToggleDevToolsLabel,
      hasToggleAppUiDevToolsLabel,
      hasActualSizeLabel,
      hasZoomInLabel,
      hasZoomOutLabel
    };
  });
}

async function getDevToolsMenuRoutingState(electronApp) {
  return electronApp.evaluate(({ BrowserWindow, Menu }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) {
      return { hasPrimary: false, hasSecondary: false, reason: "No BrowserWindow" };
    }

    const view = win.getBrowserView();
    if (!view) {
      return { hasPrimary: false, hasSecondary: false, reason: "No BrowserView" };
    }

    const menu = Menu.getApplicationMenu();
    if (!menu) {
      return { hasPrimary: false, hasSecondary: false, reason: "No application menu" };
    }

    const queue = [...menu.items];
    let primaryItem = null;
    let secondaryItem = null;

    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) continue;

      if (item.label === "Toggle Developer Tools") {
        primaryItem = item;
      }
      if (item.label === "Toggle App UI Developer Tools") {
        secondaryItem = item;
      }

      if (item.submenu?.items?.length) {
        queue.push(...item.submenu.items);
      }
    }

    if (!primaryItem || !secondaryItem) {
      return {
        hasPrimary: Boolean(primaryItem),
        hasSecondary: Boolean(secondaryItem),
        reason: "Missing expected devtools menu items"
      };
    }

    const calls = [];
    const patchWebContents = (target, wc) => {
      const original = {
        openDevTools: wc.openDevTools,
        closeDevTools: wc.closeDevTools,
        isDevToolsOpened: wc.isDevToolsOpened
      };

      wc.openDevTools = (options) => {
        calls.push({
          target,
          method: "openDevTools",
          mode: options?.mode ?? null
        });
      };
      wc.closeDevTools = () => {
        calls.push({
          target,
          method: "closeDevTools"
        });
      };
      wc.isDevToolsOpened = () => false;

      return () => {
        wc.openDevTools = original.openDevTools;
        wc.closeDevTools = original.closeDevTools;
        wc.isDevToolsOpened = original.isDevToolsOpened;
      };
    };

    const restoreView = patchWebContents("view", view.webContents);
    const restoreWindow = patchWebContents("window", win.webContents);

    try {
      primaryItem.click(undefined, win, undefined);
      const primaryCalls = calls.splice(0);

      secondaryItem.click(undefined, win, undefined);
      const secondaryCalls = calls.splice(0);

      return {
        hasPrimary: true,
        hasSecondary: true,
        primaryCalls,
        secondaryCalls
      };
    } finally {
      restoreView();
      restoreWindow();
    }
  });
}

function normalizeAcceleratorTokens(accelerator) {
  const commandOrControlToken = process.platform === "darwin" ? "command" : "control";

  return String(accelerator || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .split("+")
    .filter(Boolean)
    .map((token) => {
      if (token === "cmd") return "command";
      if (token === "ctrl") return "control";
      if (token === "commandorcontrol") return commandOrControlToken;
      return token;
    })
    .sort()
    .join("+");
}

async function getReloadMenuRoutingState(electronApp) {
  return electronApp.evaluate(({ BrowserWindow, Menu }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) {
      return { hasReload: false, hasForceReload: false, reason: "No BrowserWindow" };
    }

    const view = win.getBrowserView();
    if (!view) {
      return { hasReload: false, hasForceReload: false, reason: "No BrowserView" };
    }

    const menu = Menu.getApplicationMenu();
    if (!menu) {
      return { hasReload: false, hasForceReload: false, reason: "No application menu" };
    }

    const queue = [...menu.items];
    let reloadItem = null;
    let forceReloadItem = null;

    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) continue;

      if (item.label === "Reload") {
        reloadItem = item;
      }
      if (item.label === "Force Reload") {
        forceReloadItem = item;
      }

      if (item.submenu?.items?.length) {
        queue.push(...item.submenu.items);
      }
    }

    if (!reloadItem || !forceReloadItem) {
      return {
        hasReload: Boolean(reloadItem),
        hasForceReload: Boolean(forceReloadItem),
        reason: "Missing expected reload menu items"
      };
    }

    const calls = [];
    const patchWebContents = (target, wc) => {
      const original = {
        reload: wc.reload,
        reloadIgnoringCache: wc.reloadIgnoringCache
      };

      wc.reload = () => {
        calls.push({ target, method: "reload" });
      };
      wc.reloadIgnoringCache = () => {
        calls.push({ target, method: "reloadIgnoringCache" });
      };

      return () => {
        wc.reload = original.reload;
        wc.reloadIgnoringCache = original.reloadIgnoringCache;
      };
    };

    const runShortcutProbe = (input) => {
      const syntheticEvent = {
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        }
      };

      win.webContents.emit("before-input-event", syntheticEvent, input);
      return {
        prevented: Boolean(syntheticEvent.defaultPrevented),
        calls: calls.splice(0)
      };
    };

    const restoreView = patchWebContents("view", view.webContents);
    const restoreWindow = patchWebContents("window", win.webContents);

    try {
      reloadItem.click(undefined, win, undefined);
      const reloadCalls = calls.splice(0);

      forceReloadItem.click(undefined, win, undefined);
      const forceReloadCalls = calls.splice(0);

      const legacyShortcutRouting =
        process.platform === "darwin"
          ? null
          : {
              f5: runShortcutProbe({
                type: "keyDown",
                key: "F5",
                control: false,
                shift: false,
                alt: false,
                meta: false
              }),
              ctrlF5: runShortcutProbe({
                type: "keyDown",
                key: "F5",
                control: true,
                shift: false,
                alt: false,
                meta: false
              })
            };

      return {
        hasReload: true,
        hasForceReload: true,
        reloadAccelerator:
          typeof reloadItem.accelerator === "string" ? reloadItem.accelerator : "",
        forceReloadAccelerator:
          typeof forceReloadItem.accelerator === "string" ? forceReloadItem.accelerator : "",
        reloadCalls,
        forceReloadCalls,
        legacyShortcutRouting
      };
    } finally {
      restoreView();
      restoreWindow();
    }
  });
}

async function getZoomMenuRoutingState(electronApp) {
  return electronApp.evaluate(({ BrowserWindow, Menu }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) {
      return { hasActualSize: false, hasZoomIn: false, hasZoomOut: false, reason: "No BrowserWindow" };
    }

    const view = win.getBrowserView();
    if (!view) {
      return { hasActualSize: false, hasZoomIn: false, hasZoomOut: false, reason: "No BrowserView" };
    }

    const menu = Menu.getApplicationMenu();
    if (!menu) {
      return {
        hasActualSize: false,
        hasZoomIn: false,
        hasZoomOut: false,
        reason: "No application menu"
      };
    }

    const queue = [...menu.items];
    let actualSizeItem = null;
    let zoomInItem = null;
    let zoomOutItem = null;

    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) continue;

      if (item.label === "Actual Size") {
        actualSizeItem = item;
      }
      if (item.label === "Zoom In") {
        zoomInItem = item;
      }
      if (item.label === "Zoom Out") {
        zoomOutItem = item;
      }

      if (item.submenu?.items?.length) {
        queue.push(...item.submenu.items);
      }
    }

    if (!actualSizeItem || !zoomInItem || !zoomOutItem) {
      return {
        hasActualSize: Boolean(actualSizeItem),
        hasZoomIn: Boolean(zoomInItem),
        hasZoomOut: Boolean(zoomOutItem),
        reason: "Missing expected zoom menu items"
      };
    }

    const normalizeFactor = (factor) => Math.round(Number(factor) * 10000) / 10000;
    const factors = () => ({
      view: normalizeFactor(view.webContents.getZoomFactor()),
      window: normalizeFactor(win.webContents.getZoomFactor())
    });

    view.webContents.setZoomFactor(1);
    win.webContents.setZoomFactor(1);

    const initialFactors = factors();

    zoomInItem.click(undefined, win, undefined);
    const afterZoomInFactors = factors();

    zoomOutItem.click(undefined, win, undefined);
    const afterZoomOutFactors = factors();

    zoomInItem.click(undefined, win, undefined);
    const beforeActualSizeFactors = factors();

    actualSizeItem.click(undefined, win, undefined);
    const afterActualSizeFactors = factors();

    return {
      hasActualSize: true,
      hasZoomIn: true,
      hasZoomOut: true,
      actualSizeAccelerator:
        typeof actualSizeItem.accelerator === "string" ? actualSizeItem.accelerator : "",
      zoomInAccelerator: typeof zoomInItem.accelerator === "string" ? zoomInItem.accelerator : "",
      zoomOutAccelerator: typeof zoomOutItem.accelerator === "string" ? zoomOutItem.accelerator : "",
      initialFactors,
      afterZoomInFactors,
      afterZoomOutFactors,
      beforeActualSizeFactors,
      afterActualSizeFactors
    };
  });
}

async function run() {
  let fixture = null;
  let electronApp = null;

  try {
    fixture = await startFixtureServer();
    log(`Fixture server running at ${fixture.baseUrl}`);

    const appPath = path.resolve(__dirname, "..");
    const launchArgs = [appPath];
    if (process.env.CI) {
      // CI runners sometimes block Chromium sandboxing/GPU init under Xvfb.
      launchArgs.push("--no-sandbox", "--disable-gpu");
    }

    electronApp = await electron.launch({
      executablePath: electronBinary,
      args: launchArgs
    });

    const window = await findRendererWindow(electronApp);
    await window.waitForSelector("#toolbar", { timeout: 5000 });
    log("Main window and toolbar loaded");

    const webviewCount = await window.locator("webview").count();
    assert.strictEqual(webviewCount, 0, "Renderer should not contain <webview>");

    const bridgeCheck = await window.evaluate(() => ({
      hasBridge: typeof window.browser === "object" && window.browser !== null,
      requireType: typeof window.require
    }));
    assert.strictEqual(bridgeCheck.hasBridge, true, "window.browser bridge should exist");
    assert.strictEqual(bridgeCheck.requireType, "undefined", "window.require should be unavailable");
    log("Security invariants verified (bridge present, node integration off)");

    const menuViewState = await getMenuViewState(electronApp);
    assert.strictEqual(
      menuViewState.hasToggleFullscreenRole,
      false,
      "Application menu should not include togglefullscreen role"
    );
    assert.strictEqual(
      menuViewState.hasF11Accelerator,
      false,
      "Application menu should not include an F11 accelerator"
    );
    assert.strictEqual(
      menuViewState.hasGenericToggleDevToolsRole,
      false,
      "Application menu should not use generic toggledevtools role"
    );
    assert.strictEqual(
      menuViewState.hasGenericResetZoomRole,
      false,
      "Application menu should not use generic resetzoom role"
    );
    assert.strictEqual(
      menuViewState.hasGenericZoomInRole,
      false,
      "Application menu should not use generic zoomin role"
    );
    assert.strictEqual(
      menuViewState.hasGenericZoomOutRole,
      false,
      "Application menu should not use generic zoomout role"
    );
    assert.strictEqual(
      menuViewState.hasToggleDevToolsLabel,
      true,
      "Application menu should include Toggle Developer Tools item"
    );
    assert.strictEqual(
      menuViewState.hasToggleAppUiDevToolsLabel,
      true,
      "Application menu should include Toggle App UI Developer Tools item"
    );
    assert.strictEqual(
      menuViewState.hasActualSizeLabel,
      true,
      "Application menu should include Actual Size item"
    );
    assert.strictEqual(
      menuViewState.hasZoomInLabel,
      true,
      "Application menu should include Zoom In item"
    );
    assert.strictEqual(
      menuViewState.hasZoomOutLabel,
      true,
      "Application menu should include Zoom Out item"
    );
    log(
      "Menu view controls validated (fullscreen removed, explicit devtools and zoom items present)"
    );

    const devToolsRoutingState = await getDevToolsMenuRoutingState(electronApp);
    assert.strictEqual(
      devToolsRoutingState.hasPrimary,
      true,
      `Primary devtools menu item should exist (${devToolsRoutingState.reason || "ok"})`
    );
    assert.strictEqual(
      devToolsRoutingState.hasSecondary,
      true,
      `Secondary app-ui devtools menu item should exist (${devToolsRoutingState.reason || "ok"})`
    );
    assert.deepStrictEqual(
      devToolsRoutingState.primaryCalls,
      [{ target: "view", method: "openDevTools", mode: "detach" }],
      "Primary devtools menu item should target BrowserView webContents"
    );
    assert.deepStrictEqual(
      devToolsRoutingState.secondaryCalls,
      [{ target: "window", method: "openDevTools", mode: "detach" }],
      "App UI devtools menu item should target BrowserWindow webContents"
    );
    log("Devtools menu routing verified (page -> BrowserView, app UI -> BrowserWindow)");

    const reloadRoutingState = await getReloadMenuRoutingState(electronApp);
    assert.strictEqual(
      reloadRoutingState.hasReload,
      true,
      `Reload menu item should exist (${reloadRoutingState.reason || "ok"})`
    );
    assert.strictEqual(
      reloadRoutingState.hasForceReload,
      true,
      `Force Reload menu item should exist (${reloadRoutingState.reason || "ok"})`
    );
    assert.strictEqual(
      normalizeAcceleratorTokens(reloadRoutingState.reloadAccelerator),
      process.platform === "darwin" ? "command+r" : "control+r",
      "Reload menu item should expose Cmd/Ctrl+R accelerator"
    );
    assert.strictEqual(
      normalizeAcceleratorTokens(reloadRoutingState.forceReloadAccelerator),
      process.platform === "darwin" ? "command+r+shift" : "control+r+shift",
      "Force Reload menu item should expose Shift+Cmd/Ctrl+R accelerator"
    );
    assert.deepStrictEqual(
      reloadRoutingState.reloadCalls,
      [{ target: "view", method: "reload" }],
      "Reload menu item should target BrowserView webContents.reload()"
    );
    assert.deepStrictEqual(
      reloadRoutingState.forceReloadCalls,
      [{ target: "view", method: "reloadIgnoringCache" }],
      "Force Reload menu item should target BrowserView webContents.reloadIgnoringCache()"
    );

    if (process.platform !== "darwin") {
      assert.strictEqual(
        reloadRoutingState.legacyShortcutRouting?.f5?.prevented,
        true,
        "F5 should be handled as BrowserView reload shortcut"
      );
      assert.strictEqual(
        reloadRoutingState.legacyShortcutRouting?.ctrlF5?.prevented,
        true,
        "Ctrl+F5 should be handled as BrowserView force reload shortcut"
      );
      assert.deepStrictEqual(
        reloadRoutingState.legacyShortcutRouting?.f5?.calls,
        [{ target: "view", method: "reload" }],
        "F5 shortcut should target BrowserView webContents.reload()"
      );
      assert.deepStrictEqual(
        reloadRoutingState.legacyShortcutRouting?.ctrlF5?.calls,
        [{ target: "view", method: "reloadIgnoringCache" }],
        "Ctrl+F5 shortcut should target BrowserView webContents.reloadIgnoringCache()"
      );
    }
    log("Reload menu routing verified (menu items and shortcuts target BrowserView)");

    const zoomRoutingState = await getZoomMenuRoutingState(electronApp);
    assert.strictEqual(
      zoomRoutingState.hasActualSize,
      true,
      `Actual Size menu item should exist (${zoomRoutingState.reason || "ok"})`
    );
    assert.strictEqual(
      zoomRoutingState.hasZoomIn,
      true,
      `Zoom In menu item should exist (${zoomRoutingState.reason || "ok"})`
    );
    assert.strictEqual(
      zoomRoutingState.hasZoomOut,
      true,
      `Zoom Out menu item should exist (${zoomRoutingState.reason || "ok"})`
    );
    assert.strictEqual(
      normalizeAcceleratorTokens(zoomRoutingState.actualSizeAccelerator),
      normalizeAcceleratorTokens("CommandOrControl+0"),
      "Actual Size menu item should expose Cmd/Ctrl+0 accelerator"
    );
    assert.strictEqual(
      normalizeAcceleratorTokens(zoomRoutingState.zoomInAccelerator),
      normalizeAcceleratorTokens("CommandOrControl+Plus"),
      "Zoom In menu item should expose Cmd/Ctrl+Plus accelerator"
    );
    assert.strictEqual(
      normalizeAcceleratorTokens(zoomRoutingState.zoomOutAccelerator),
      normalizeAcceleratorTokens("CommandOrControl+-"),
      "Zoom Out menu item should expose Cmd/Ctrl+- accelerator"
    );
    assert.strictEqual(
      zoomRoutingState.initialFactors.view,
      1,
      "BrowserView zoom factor should start at 1 for probe"
    );
    assert.strictEqual(
      zoomRoutingState.initialFactors.window,
      1,
      "BrowserWindow zoom factor should start at 1 for probe"
    );
    assert.ok(
      zoomRoutingState.afterZoomInFactors.view > zoomRoutingState.initialFactors.view,
      "Zoom In should increase BrowserView zoom factor"
    );
    assert.strictEqual(
      zoomRoutingState.afterZoomInFactors.window,
      1,
      "Zoom In should not change BrowserWindow zoom factor"
    );
    assert.ok(
      zoomRoutingState.afterZoomOutFactors.view < zoomRoutingState.afterZoomInFactors.view,
      "Zoom Out should reduce BrowserView zoom factor"
    );
    assert.strictEqual(
      zoomRoutingState.afterZoomOutFactors.window,
      1,
      "Zoom Out should not change BrowserWindow zoom factor"
    );
    assert.ok(
      zoomRoutingState.beforeActualSizeFactors.view > zoomRoutingState.initialFactors.view,
      "BrowserView zoom factor should be above 1 before Actual Size"
    );
    assert.strictEqual(
      zoomRoutingState.beforeActualSizeFactors.window,
      1,
      "BrowserWindow zoom factor should stay locked at 1 before Actual Size"
    );
    assert.strictEqual(
      zoomRoutingState.afterActualSizeFactors.view,
      1,
      "Actual Size should reset BrowserView zoom factor to 1"
    );
    assert.strictEqual(
      zoomRoutingState.afterActualSizeFactors.window,
      1,
      "Actual Size should not change BrowserWindow zoom factor"
    );
    log("Zoom menu routing verified (menu + shortcuts mapped to BrowserView; app UI stays at 100%)");

    await navigateWithToolbar(window, fixture.baseUrl);
    await waitForViewUrl(
      electronApp,
      (url) => url === `${fixture.baseUrl}/` || url === fixture.baseUrl,
      "initial local navigation"
    );
    await waitForStatus(window, (text) => text === "Done", "ready status after initial navigation");
    log("Initial navigation succeeded");

    const fixtureUrl = new URL(fixture.baseUrl);
    const localhostShorthand = `localhost:${fixtureUrl.port}`;
    const localhostUrl = `http://${localhostShorthand}`;
    await navigateWithToolbar(window, localhostShorthand);
    await waitForViewUrl(
      electronApp,
      (url) => url === `${localhostUrl}/` || url === localhostUrl,
      "localhost host:port shorthand navigation"
    );
    await waitForStatus(window, (text) => text === "Done", "ready status after localhost shorthand");
    log("Localhost host:port shorthand navigation passed");

    await navigateWithToolbar(window, `${fixture.baseUrl}/second`);
    await waitForViewUrl(
      electronApp,
      (url) => url === `${fixture.baseUrl}/second`,
      "navigation to /second"
    );

    const backDisabledAfterSecond = await window.isDisabled("#back");
    assert.strictEqual(backDisabledAfterSecond, false, "Back button should be enabled on second page");

    await window.click("#back");
    await waitForViewUrl(
      electronApp,
      (url) => url === `${localhostUrl}/` || url === localhostUrl,
      "back navigation to localhost shorthand page"
    );

    const forwardDisabledAfterBack = await window.isDisabled("#forward");
    assert.strictEqual(forwardDisabledAfterBack, false, "Forward button should be enabled after going back");

    await window.click("#forward");
    await waitForViewUrl(
      electronApp,
      (url) => url === `${fixture.baseUrl}/second`,
      "forward navigation to /second"
    );

    await window.click("#reload");
    await waitForStatus(
      window,
      (text) => text === "Loading..." || text === "Done",
      "status update during reload"
    );
    await waitForStatus(window, (text) => text === "Done", "done status after reload");
    log("Toolbar back/forward/reload interactions passed");

    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const view = win.getBrowserView();
      await view.webContents.executeJavaScript(
        "window.open('/popup', '_blank');"
      );
    });

    const popupState = await waitForViewUrl(
      electronApp,
      (url) => url === `${fixture.baseUrl}/popup`,
      "same-view popup navigation"
    );
    assert.strictEqual(popupState.windowCount, 1, "Popup should not create another BrowserWindow");
    log("Popup reuse behavior passed");

    const urlBeforeExternal = popupState.url;
    await navigateWithToolbar(window, "mailto:test@example.com");
    await waitForStatus(
      window,
      (text) => text.startsWith("Opened external link") || text.startsWith("Error:"),
      "external URL handoff status"
    );

    const afterExternalState = await getViewState(electronApp);
    assert.ok(afterExternalState, "BrowserView state should still be available");
    assert.strictEqual(
      afterExternalState.url,
      urlBeforeExternal,
      "External scheme navigation should not replace BrowserView URL"
    );
    log("External URL handoff behavior passed");

    log("All smoke checks passed");
  } finally {
    log("Starting teardown");
    if (electronApp) {
      await closeElectronApp(electronApp).catch((error) => {
        log(`Error during Electron teardown: ${error?.message || error}`);
      });
    }
    if (fixture?.server) {
      await stopFixtureServer(fixture.server, fixture.sockets).catch((error) => {
        log(`Error during fixture server teardown: ${error?.message || error}`);
      });
    }
    log("Teardown complete");
  }
}

async function main() {
  const watchdog = startWatchdog();
  let exitCode = 0;

  try {
    await run();
  } catch (error) {
    exitCode = 1;
    process.stderr.write(`[smoke] FAILED: ${error?.stack || error}\n`);
  } finally {
    clearTimeout(watchdog);
    finalizeAndExit(exitCode);
  }
}

main().catch((error) => {
  process.stderr.write(`[smoke] FAILED: unexpected shutdown error: ${error?.stack || error}\n`);
  process.exit(1);
});
