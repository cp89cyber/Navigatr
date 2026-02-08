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
