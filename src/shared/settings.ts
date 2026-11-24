/**
 * Settings stored in chrome.storage.sync. Later tickets add `mode` (#6) and
 * `intervalSeconds` (#3) here, each with a default in DEFAULT_SETTINGS.
 */
export interface Settings {
  /** Configured origins, e.g. "https://gitlab.com". */
  domains: string[];
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  domains: ["https://gitlab.com"],
});

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored } as Settings;
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.sync.set(patch);
}

/** Calls `listener` with the keys that changed whenever synced settings change. */
export function onSettingsChanged(listener: (changedKeys: (keyof Settings)[]) => void): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    listener(Object.keys(changes) as (keyof Settings)[]);
  });
}
