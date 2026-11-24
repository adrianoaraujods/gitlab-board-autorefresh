/**
 * The toolbar badge states (spec #1): "idle" (grey) and "polling" (green).
 * Later tickets add "blocked" (yellow, #4) and "error" (red, #8). The Refresh
 * Scheduler emits them as set-badge commands.
 */
export type BadgeState = "idle" | "polling";
