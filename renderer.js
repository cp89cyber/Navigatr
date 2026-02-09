const backBtn = document.getElementById("back");
const forwardBtn = document.getElementById("forward");
const reloadBtn = document.getElementById("reload");
const urlInput = document.getElementById("url");
const adblockToggle = document.getElementById("adblock-toggle");
const blockedCount = document.getElementById("blocked-count");
const statusEl = document.getElementById("status");
const toolbarEl = document.getElementById("toolbar");

const browserBridge = window.browser;
let unsubscribeState = null;
let unsubscribeAdblock = null;
let resizeTimer = null;
let isEditingUrl = false;

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

  if (state.url && !isEditingUrl) {
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

function applyAdblockState(state) {
  if (!state || typeof state !== "object") return;
  if (!adblockToggle || !blockedCount) return;

  if (typeof state.enabled === "boolean") {
    adblockToggle.checked = state.enabled;
  }

  if (typeof state.blockedTotal === "number") {
    blockedCount.textContent = `Blocked: ${state.blockedTotal}`;
  }
}

async function initAdblockControls() {
  if (!adblockToggle || !blockedCount) return;

  if (!window.adblock) {
    adblockToggle.disabled = true;
    blockedCount.textContent = "Blocked: n/a";
    return;
  }

  try {
    applyAdblockState(await window.adblock.getState());
  } catch (_err) {
    setStatus("Ad blocker unavailable");
  }

  adblockToggle.addEventListener("change", async () => {
    const desiredState = adblockToggle.checked;
    adblockToggle.disabled = true;

    try {
      const state = await window.adblock.setEnabled(desiredState);
      applyAdblockState(state);
    } catch (_err) {
      adblockToggle.checked = !desiredState;
      setStatus("Could not update ad blocker");
    } finally {
      adblockToggle.disabled = false;
    }
  });

  unsubscribeAdblock = window.adblock.onStats((state) => {
    applyAdblockState(state);
  });
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
    isEditingUrl = false;
    browserBridge.navigate(urlInput.value).catch(showBridgeError);
  }
});

urlInput.addEventListener("focus", () => {
  isEditingUrl = true;
});

urlInput.addEventListener("input", () => {
  isEditingUrl = true;
});

urlInput.addEventListener("blur", () => {
  isEditingUrl = false;
});

window.addEventListener("resize", () => {
  syncToolbarHeightSoon();
});

window.addEventListener("beforeunload", () => {
  if (typeof unsubscribeState === "function") {
    unsubscribeState();
  }

  if (typeof unsubscribeAdblock === "function") {
    unsubscribeAdblock();
  }

  if (resizeTimer) {
    clearTimeout(resizeTimer);
    resizeTimer = null;
  }
});

window.addEventListener("DOMContentLoaded", () => {
  void initAdblockControls();

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
