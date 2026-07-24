export type ThemeSetting = "system" | "dark" | "light";
export type LanguageSetting = "ko" | "en";
export type SuggestionMinConfidence = "high" | "medium";

export type PaiMSettings = {
  theme: ThemeSetting;
  language: LanguageSetting;
  serverUrl: string;
  suggestionMin: SuggestionMinConfidence;
  dueSoonDays: number;
};

export const PAIM_SETTINGS_STORAGE_KEY = "paim.settings.v1";
export const DEFAULT_PAIM_API_ROOT_URL = "http://127.0.0.1:7272";
// Older desktop bundles persisted this default. It is migration data only and is
// never returned as a connection target.
const LEGACY_PAIM_API_ROOT_URL = "http://127.0.0.1:8000";

export const DEFAULT_PAIM_SETTINGS: PaiMSettings = {
  theme: "system",
  language: "ko",
  serverUrl: "",
  suggestionMin: "medium",
  dueSoonDays: 3,
};

export function normalizePaimServerUrl(value: string) {
  return value.trim().replace(/\/+$/, "").replace(/\/api\/v1$/, "");
}

function normalizeDueSoonDays(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(7, Math.max(1, Math.round(parsed))) : 3;
}

export function normalizePaimSettings(value: Partial<PaiMSettings>): PaiMSettings {
  return {
    theme: value.theme === "dark" || value.theme === "light" ? value.theme : "system",
    language: value.language === "en" ? "en" : "ko",
    serverUrl: typeof value.serverUrl === "string" ? normalizePaimServerUrl(value.serverUrl) : "",
    suggestionMin: value.suggestionMin === "high" ? "high" : "medium",
    dueSoonDays: normalizeDueSoonDays(value.dueSoonDays),
  };
}

export function loadPaimSettings(): PaiMSettings {
  try {
    const storedSettings = JSON.parse(
      window.localStorage.getItem(PAIM_SETTINGS_STORAGE_KEY) || "{}",
    ) as Partial<PaiMSettings>;

    if (normalizePaimServerUrl(storedSettings.serverUrl ?? "") === LEGACY_PAIM_API_ROOT_URL) {
      storedSettings.serverUrl = "";
      window.localStorage.setItem(PAIM_SETTINGS_STORAGE_KEY, JSON.stringify(storedSettings));
    }

    return normalizePaimSettings(storedSettings);
  } catch {
    return DEFAULT_PAIM_SETTINGS;
  }
}

export function savePaimSettings(settings: PaiMSettings) {
  window.localStorage.setItem(PAIM_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

export function resolvePaimApiRootUrl(serverUrl: string) {
  const settingsUrl = normalizePaimServerUrl(serverUrl);
  const envUrl = normalizePaimServerUrl(
    (import.meta.env.VITE_PAIM_API_BASE_URL as string | undefined) || DEFAULT_PAIM_API_ROOT_URL,
  );

  return settingsUrl || envUrl || DEFAULT_PAIM_API_ROOT_URL;
}

export function getPaimApiRootUrl() {
  return resolvePaimApiRootUrl(loadPaimSettings().serverUrl);
}
