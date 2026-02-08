const backBtn = document.getElementById("back");
const forwardBtn = document.getElementById("forward");
const reloadBtn = document.getElementById("reload");
const urlInput = document.getElementById("url");
const statusEl = document.getElementById("status");
const toolbarEl = document.getElementById("toolbar");

const browserBridge = window.browser;
let unsubscribeState = null;
let resizeTimer = null;

function setControlsEnabled(enabled) {
  backBtn.disabled = !enabled;
  forwardBtn.disabled = !enabled;
  reloadBtn.disabled = !enabled;
  urlInput.disabled = !enabled;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function applyState(state) {
  if (!state) return;

  backBtn.disabled = !state.canGoBack;
  forwardBtn.disabled = !state.canGoForward;
  setStatus(state.status || (state.isLoading ? "Loading..." : "Ready"));

  if (state.url) {
    urlInput.value = state.url;
  }

  document.title = state.title ? `${state.title} - Navigatr` : "Navigatr";
}

function showBridgeError(error) {
  setStatus(`Error: ${error?.message || "Browser bridge unavailable"}`);
}

async function syncToolbarHeight() {
  if (!browserBridge || !toolbarEl) return;
  const height = Math.ceil(toolbarEl.getBoundingClientRect().height);

  try {
    await browserBridge.setToolbarHeight(height);
  } catch (error) {
    showBridgeError(error);
  }
}

function syncToolbarHeightSoon() {
  if (resizeTimer) {
    clearTimeout(resizeTimer);
  }

  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    void syncToolbarHeight();
  }, 50);
}

async function refreshState() {
  if (!browserBridge) return;

  try {
    const state = await browserBridge.getState();
    applyState(state);
  } catch (error) {
    showBridgeError(error);
  }
}

backBtn.addEventListener("click", () => {
  if (!browserBridge) return;
  browserBridge.back().catch(showBridgeError);
});

forwardBtn.addEventListener("click", () => {
  if (!browserBridge) return;
  browserBridge.forward().catch(showBridgeError);
});

reloadBtn.addEventListener("click", () => {
  if (!browserBridge) return;
  browserBridge.reload().catch(showBridgeError);
});

urlInput.addEventListener("keydown", (event) => {
  if (!browserBridge) return;
  if (event.key === "Enter") {
    browserBridge.navigate(urlInput.value).catch(showBridgeError);
  }
});

window.addEventListener("resize", () => {
  syncToolbarHeightSoon();
});

window.addEventListener("beforeunload", () => {
  if (typeof unsubscribeState === "function") {
    unsubscribeState();
  }

  if (resizeTimer) {
    clearTimeout(resizeTimer);
    resizeTimer = null;
  }
});

window.addEventListener("DOMContentLoaded", () => {
  if (!browserBridge) {
    setControlsEnabled(false);
    setStatus("Error: Browser bridge unavailable");
    return;
  }

  setControlsEnabled(true);

  unsubscribeState = browserBridge.onStateChange((state) => {
    applyState(state);
  });

  void refreshState();
  void syncToolbarHeight();
});
