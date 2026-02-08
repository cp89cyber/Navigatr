const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const DEFAULT_SETTINGS = {
  enabled: true
};

function getSettingsPath() {
  return path.join(app.getPath("userData"), "adblock-settings.json");
}

function loadSettings() {
  const filePath = getSettingsPath();

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      enabled:
        typeof parsed?.enabled === "boolean"
          ? parsed.enabled
          : DEFAULT_SETTINGS.enabled
    };
  } catch (_err) {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(next) {
  const safe = {
    enabled:
      typeof next?.enabled === "boolean" ? next.enabled : DEFAULT_SETTINGS.enabled
  };

  const filePath = getSettingsPath();

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(safe, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to save adblock settings:", err);
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings
};
