/**
 * The toolbar badge states (spec #1): "idle" (grey), "polling" (green) and
 * "blocked" (yellow, #4). A later ticket adds "error" (red, #8). The Refresh
 * Scheduler emits them as set-badge commands.
 */
export type BadgeState = "idle" | "polling" | "blocked";
