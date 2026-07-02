export type ThemeSetting = "system" | "dark" | "light";
export type SuggestionMinConfidence = "high" | "medium";

export type PaiMSettings = {
  theme: ThemeSetting;
  serverUrl: string;
  suggestionMin: SuggestionMinConfidence;
  dueSoonDays: number;
};

export const PAIM_SETTINGS_STORAGE_KEY = "paim.settings.v1";
export const DEFAULT_PAIM_API_ROOT_URL = "http://127.0.0.1:8000";

export const DEFAULT_PAIM_SETTINGS: PaiMSettings = {
  theme: "system",
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
    serverUrl: typeof value.serverUrl === "string" ? normalizePaimServerUrl(value.serverUrl) : "",
    suggestionMin: value.suggestionMin === "high" ? "high" : "medium",
    dueSoonDays: normalizeDueSoonDays(value.dueSoonDays),
  };
}

export function loadPaimSettings(): PaiMSettings {
  try {
    return normalizePaimSettings({
      ...DEFAULT_PAIM_SETTINGS,
      ...JSON.parse(window.localStorage.getItem(PAIM_SETTINGS_STORAGE_KEY) || "{}"),
    });
  } catch {
    return DEFAULT_PAIM_SETTINGS;
  }
}

export function savePaimSettings(settings: PaiMSettings) {
  window.localStorage.setItem(PAIM_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

export function getPaimApiRootUrl() {
  const settingsUrl = normalizePaimServerUrl(loadPaimSettings().serverUrl);
  const envUrl = normalizePaimServerUrl(
    (import.meta.env.VITE_PAIM_API_BASE_URL as string | undefined) || DEFAULT_PAIM_API_ROOT_URL,
  );

  return settingsUrl || envUrl || DEFAULT_PAIM_API_ROOT_URL;
}
