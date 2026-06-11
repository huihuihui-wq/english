// localStorage utilities
const STORAGE_KEY = "shadow-reader.settings.v1";

const DEFAULT_SETTINGS = {
  speed: 1,
  loopCount: 3,
  pauseSec: 2,
  autoReplay: false,
  showZh: false,
  nativeLang: "en", // user's native language for dictionary lookups
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

// Native language manager — keeps localStorage in sync with backend DICT_LANG setting
const NativeLang = (() => {
  let supported = null;
  let listeners = [];

  async function load() {
    if (supported) return supported;
    try {
      const resp = await fetch("/api/word/languages");
      if (resp.ok) {
        const data = await resp.json();
        supported = data.languages || [];
        return supported;
      }
    } catch (e) {
      console.warn("[NativeLang] failed to load supported list:", e);
    }
    // Fallback
    supported = [
      { id: "en", name: "English", native: "English" },
      { id: "zh", name: "Chinese (Simplified)", native: "简体中文" },
      { id: "ja", name: "Japanese", native: "日本語" },
      { id: "ko", name: "Korean", native: "한국어" },
    ];
    return supported;
  }

  function current() {
    return (window.AppState?.settings?.nativeLang) || DEFAULT_SETTINGS.nativeLang;
  }

  function set(lang, { persistBackend = true } = {}) {
    const s = window.AppState?.settings;
    if (!s) return;
    s.nativeLang = lang;
    Storage.save(s);
    listeners.forEach((fn) => {
      try { fn(lang); } catch (e) { console.error(e); }
    });
    if (persistBackend) {
      fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ DICT_LANG: lang }),
      }).catch((e) => console.warn("[NativeLang] backend sync failed:", e));
    }
  }

  function onChange(fn) {
    listeners.push(fn);
  }

  function detect() {
    const stored = Storage.load().nativeLang;
    if (stored && stored !== DEFAULT_SETTINGS.nativeLang) return stored;
    const nav = (navigator.language || "en").toLowerCase();
    if (nav.startsWith("zh")) return "zh";
    if (nav.startsWith("ja")) return "ja";
    if (nav.startsWith("ko")) return "ko";
    if (nav.startsWith("fr")) return "fr";
    if (nav.startsWith("de")) return "de";
    if (nav.startsWith("es")) return "es";
    if (nav.startsWith("pt")) return "pt";
    if (nav.startsWith("ru")) return "ru";
    if (nav.startsWith("it")) return "it";
    return "en";
  }

  return { load, current, set, onChange, detect };
})();

window.NativeLang = NativeLang;
