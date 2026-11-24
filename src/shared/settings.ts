/**
 * Settings stored in chrome.storage.sync. Later tickets add `mode` (#6) here,
 * with a default in DEFAULT_SETTINGS.
 */
import { DEFAULT_INTERVAL_SECONDS, normalizeIntervalSeconds } from "../core/refresh-interval";

export interface Settings {
  /** Configured origins, e.g. "https://gitlab.com". */
  domains: string[];
  /** Refresh interval in whole seconds (default 30, minimum 10). */
  intervalSeconds: number;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  domains: ["https://gitlab.com"],
  intervalSeconds: DEFAULT_INTERVAL_SECONDS,
});

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const settings = { ...DEFAULT_SETTINGS, ...stored } as Settings;
  return { ...settings, intervalSeconds: normalizeIntervalSeconds(settings.intervalSeconds) };
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
