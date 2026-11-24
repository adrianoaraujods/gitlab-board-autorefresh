/**
 * The toolbar badge states (spec #1): "idle" (grey), "polling" (green) and
 * "error" (red: signed out or reloads failing, #8).
 * Ticket #4 adds "blocked" (yellow). The Refresh
 * Scheduler emits them as set-badge commands.
 */
export type BadgeState = "idle" | "polling" | "error";
