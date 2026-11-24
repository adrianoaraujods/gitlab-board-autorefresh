/**
 * The refresh interval setting: whole seconds, default 30, minimum 10.
 */
export const DEFAULT_INTERVAL_SECONDS = 30;
export const MIN_INTERVAL_SECONDS = 10;

export type IntervalSecondsResult = { ok: true; seconds: number } | { ok: false; error: string };

/** Validates an interval typed in the options page. */
export function parseIntervalSeconds(input: string): IntervalSecondsResult {
  const text = input.trim();
  if (!/^-?\d+$/.test(text)) return { ok: false, error: "Enter a whole number of seconds." };
  const seconds = Number(text);
  if (seconds < MIN_INTERVAL_SECONDS) {
    return { ok: false, error: `The interval must be at least ${MIN_INTERVAL_SECONDS} seconds.` };
  }
  return { ok: true, seconds };
}

/** Makes a stored value safe to use: falls back to the default and enforces the minimum. */
export function normalizeIntervalSeconds(stored: unknown): number {
  if (typeof stored !== "number" || !Number.isFinite(stored)) return DEFAULT_INTERVAL_SECONDS;
  return Math.max(MIN_INTERVAL_SECONDS, Math.floor(stored));
}
