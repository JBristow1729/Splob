import { COLOR_ORDER, STORAGE_KEY } from "../config.js";

const defaultSettings = {
  music: 35,
  sfx: 80,
  preferredColor: "cyan",
  username: ""
};

export function loadSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return normalizeSettings({ ...defaultSettings, ...parsed });
  } catch {
    return { ...defaultSettings };
  }
}

export function saveSettings(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeSettings(settings)));
}

export function sanitizeUsername(value) {
  return value.replace(/[^a-z0-9 _-]/gi, "").slice(0, 16);
}

function normalizeSettings(settings) {
  return {
    music: clampNumber(settings.music, 0, 100, defaultSettings.music),
    sfx: clampNumber(settings.sfx, 0, 100, defaultSettings.sfx),
    preferredColor: COLOR_ORDER.includes(settings.preferredColor) ? settings.preferredColor : defaultSettings.preferredColor,
    username: sanitizeUsername(String(settings.username || ""))
  };
}

function clampNumber(value, min, max, fallback) {
  const next = Number(value);
  return Number.isFinite(next) ? Math.min(max, Math.max(min, next)) : fallback;
}
