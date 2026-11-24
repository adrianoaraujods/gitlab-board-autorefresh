/**
 * The toolbar badge states (spec #1). The skeleton only uses "idle"; later
 * tickets add "polling" (green), "blocked" (yellow) and "error" (red), emitted
 * as set-badge commands by the Refresh Scheduler.
 */
export type BadgeState = "idle";
