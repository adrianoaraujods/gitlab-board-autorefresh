/** Settings stored in chrome.storage.sync, with defaults in DEFAULT_SETTINGS. */
import { DEFAULT_INTERVAL_SECONDS, normalizeIntervalSeconds } from "../core/refresh-interval";
import {
  DEFAULT_SAFETY_NET_MINUTES,
  normalizeDetection,
  normalizeSafetyNetMinutes,
  normalizeTabMode,
  type Detection,
  type SchedulerSettings,
  type TabMode,
} from "../core/refresh-scheduler";

export interface Settings {
  /** Configured origins, e.g. "https://gitlab.com". */
  domains: string[];
  /** Refresh interval in whole seconds (default 30, minimum 10). */
  intervalSeconds: number;
  /** Which board tabs refresh (default "current-tab"). */
  mode: TabMode;
  /** Whether a due tick reloads only when the board changed ("smart", the default) or always (v1). */
  detection: Detection;
  /** Experimental: apply detected changes through the board's data layer instead of reloading (default off). */
  updateInPlace: boolean;
  /** Whether the user's own edits also reload the board (default false: they are already on screen). */
  refreshAfterOwnEdits: boolean;
  /** Minutes between safety-net full reloads in smart mode (default 15, 0 = off). */
  safetyNetMinutes: number;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  domains: ["https://gitlab.com"],
  intervalSeconds: DEFAULT_INTERVAL_SECONDS,
  mode: "current-tab",
  detection: "smart",
  updateInPlace: false,
  refreshAfterOwnEdits: false,
  safetyNetMinutes: DEFAULT_SAFETY_NET_MINUTES,
});

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const settings = { ...DEFAULT_SETTINGS, ...stored } as Settings;
  return {
    ...settings,
    intervalSeconds: normalizeIntervalSeconds(settings.intervalSeconds),
    mode: normalizeTabMode(settings.mode),
    detection: normalizeDetection(settings.detection),
    updateInPlace: settings.updateInPlace === true,
    refreshAfterOwnEdits: settings.refreshAfterOwnEdits === true,
    safetyNetMinutes: normalizeSafetyNetMinutes(settings.safetyNetMinutes),
  };
}

/** The Refresh Scheduler's view of the settings. */
export function toSchedulerSettings({
  intervalSeconds,
  mode,
  detection,
  safetyNetMinutes,
}: Pick<Settings, "intervalSeconds" | "mode" | "detection" | "safetyNetMinutes">): SchedulerSettings {
  return { intervalMs: intervalSeconds * 1000, mode, detection, safetyNetMinutes };
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
