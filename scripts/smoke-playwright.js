#!/usr/bin/env node
"use strict";

const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");

const electronBinary = require("electron");
const { _electron: electron } = require("playwright");

const HOST = "127.0.0.1";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    baseUrl: `http://${HOST}:${address.port}`
  };
}

async function stopFixtureServer(server) {
  if (!server) return;
  await new Promise((resolve) => {
    server.close(() => resolve());
  });
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
    if (electronApp) {
      await electronApp.close().catch(() => {});
    }
    if (fixture?.server) {
      await stopFixtureServer(fixture.server);
    }
  }
}

run().catch((error) => {
  process.stderr.write(`[smoke] FAILED: ${error?.stack || error}\n`);
  process.exitCode = 1;
});
