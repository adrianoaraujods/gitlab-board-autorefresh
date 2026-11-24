/**
 * The toolbar badge states (spec #1): "idle" (grey), "polling" (green) and
 * "updates" (blue: changes wait for the window to be left, #14),
 * "blocked" (yellow: a reload was skipped because the user is mid-edit, #4)
 * and "error" (red: signed out or reloads failing, #8). The Refresh
 * Scheduler emits them as set-badge commands.
 */
export type BadgeState = "idle" | "polling" | "updates" | "blocked" | "error";
