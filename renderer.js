const backBtn = document.getElementById("back");
const forwardBtn = document.getElementById("forward");
const reloadBtn = document.getElementById("reload");
const urlInput = document.getElementById("url");
const statusEl = document.getElementById("status");
const webview = document.getElementById("webview");

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
});
