// localStorage 工具
const STORAGE_KEY = "shadow-reader.settings.v1";

const DEFAULT_SETTINGS = {
  speed: 1,
  loopCount: 3,
  pauseSec: 2,
  autoReplay: false,
  showZh: false,
};

const Storage = {
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  },
  save(settings) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
      console.warn("localStorage save failed:", e);
    }
  },
};

window.Storage = Storage;
