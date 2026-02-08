const backBtn = document.getElementById("back");
const forwardBtn = document.getElementById("forward");
const reloadBtn = document.getElementById("reload");
const urlInput = document.getElementById("url");
const adblockToggle = document.getElementById("adblock-toggle");
const blockedCount = document.getElementById("blocked-count");
const statusEl = document.getElementById("status");
const webview = document.getElementById("webview");
let unsubscribeAdblock = null;

function normalizeInput(raw) {
  const value = raw.trim();
  if (!value) return null;

  const hasProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
  if (hasProtocol) return value;

  const looksLikeDomain = value.includes(".") && !value.includes(" ");
  if (looksLikeDomain) return `https://${value}`;

  return `https://duckduckgo.com/?q=${encodeURIComponent(value)}`;
}

function navigate(raw) {
  const next = normalizeInput(raw);
  if (!next) return;
  webview.loadURL(next);
}

function updateNavState() {
  backBtn.disabled = !webview.canGoBack();
  forwardBtn.disabled = !webview.canGoForward();
}

function applyAdblockState(state) {
  if (!state || typeof state !== "object") return;

  if (typeof state.enabled === "boolean") {
    adblockToggle.checked = state.enabled;
  }

  if (typeof state.blockedTotal === "number") {
    blockedCount.textContent = `Blocked: ${state.blockedTotal}`;
  }
}

async function initAdblockControls() {
  if (!window.adblock) {
    adblockToggle.disabled = true;
    blockedCount.textContent = "Blocked: n/a";
    return;
  }

  try {
    applyAdblockState(await window.adblock.getState());
  } catch (_err) {
    statusEl.textContent = "Ad blocker unavailable";
  }

  adblockToggle.addEventListener("change", async () => {
    const desiredState = adblockToggle.checked;
    adblockToggle.disabled = true;

    try {
      const state = await window.adblock.setEnabled(desiredState);
      applyAdblockState(state);
    } catch (_err) {
      adblockToggle.checked = !desiredState;
      statusEl.textContent = "Could not update ad blocker";
    } finally {
      adblockToggle.disabled = false;
    }
  });

  unsubscribeAdblock = window.adblock.onStats((state) => {
    applyAdblockState(state);
  });
}

backBtn.addEventListener("click", () => {
  if (webview.canGoBack()) webview.goBack();
});

forwardBtn.addEventListener("click", () => {
  if (webview.canGoForward()) webview.goForward();
});

reloadBtn.addEventListener("click", () => {
  webview.reload();
});

urlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    navigate(urlInput.value);
  }
});

webview.addEventListener("did-start-loading", () => {
  statusEl.textContent = "Loading...";
  updateNavState();
});

webview.addEventListener("did-stop-loading", () => {
  statusEl.textContent = "Done";
  urlInput.value = webview.getURL();
  updateNavState();
});

webview.addEventListener("did-fail-load", (event) => {
  statusEl.textContent = `Error: ${event.errorDescription || "Failed to load"}`;
});

window.addEventListener("DOMContentLoaded", () => {
  urlInput.value = webview.getURL();
  updateNavState();
  initAdblockControls();
});

window.addEventListener("beforeunload", () => {
  if (typeof unsubscribeAdblock === "function") {
    unsubscribeAdblock();
  }
});
