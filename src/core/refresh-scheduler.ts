/**
 * Refresh Scheduler: the pure policy core (spec #1). A transition
 * `(state, event, now) → { state, commands }` with no browser dependencies.
 *
 * Every transition runs the same small steps:
 *
 * 1. `applyEvent` records what the event says about the world (focus,
 *    settings, page load, a fired timer) in the state. No decisions here.
 * 2. `plan` decides what the tab should be doing right now from the state
 *    alone: frozen (nothing to say), halted by a rule in `HALT_RULES`,
 *    waiting for `nextDueAt`, or due.
 * 3. `realise` turns the plan into commands by diffing it against what was
 *    already commanded (timer, badge), so commands are only emitted on change.
 *    A due plan runs `onDue`, which checks for blockers and then reloads.
 *
 * A due reload first asks the adapter to run the Blocker Detector
 * (`check-blockers`) and reloads only once it answers `blockers-checked` with
 * no reasons (#4).
 *
 * Extending (tickets #5–#8): add an event to `SchedulerEvent` and handle it in
 * `applyEvent`; add input fields to `SchedulerState`; add a halt rule to
 * `HALT_RULES`; adjust `nextDueAt` (backoff). Add commands to
 * `SchedulerCommand`.
 */
import type { BadgeState } from "./badge";
import type { BlockerReason } from "./blocker-detector";

/**
 * Which board tabs refresh: only the visible, active tab of each window
 * ("Current tab", the default), or every board tab ("All tabs").
 */
export type TabMode = "current-tab" | "all-tabs";

export interface SchedulerSettings {
  intervalMs: number;
  mode: TabMode;
}

/**
 * The part of the state that must survive a page reload. The adapter stores it
 * per tab whenever a `persist` command is emitted and passes it back in the
 * next `page-loaded` event.
 */
export interface PersistedSchedulerState {
  /** Epoch ms of the last reload, or the first load of the tab. */
  lastReloadAt: number | null;
  /**
   * Whether the user paused this tab from the popup. Optional so a restored
   * state without it keeps the current value (the background worker owns the
   * pause flag and the adapter merges it into `restored`).
   */
  paused?: boolean;
}

/** Why the tab is in its current status, alongside the badge colour. */
export type StatusReason = "paused" | "focused" | "polling" | "not-current-tab" | "blocked";

export interface SchedulerStatus {
  badge: BadgeState;
  reason: StatusReason;
}

export interface SchedulerState {
  /**
   * `starting` until the first `page-loaded`; `reloading` once a reload was
   * commanded (the page is about to go away, so nothing more is emitted).
   */
  phase: "starting" | "running" | "reloading";
  settings: SchedulerSettings;
  /** Whether the board's window has focus. */
  focused: boolean;
  /** Whether the page is visible (`document.visibilityState`). */
  visible: boolean;
  /** Whether the tab is the active tab of its window. */
  active: boolean;
  persisted: PersistedSchedulerState;
  /**
   * The blocker check for the due reload: `idle` when none is outstanding,
   * `pending` once `check-blockers` was commanded, `clear` when it answered
   * with no reasons (the reload may go ahead in this transition only).
   */
  blockerCheck: "idle" | "pending" | "clear";
  /** Epoch ms of the last tick skipped because something blocked the reload, or `null`. */
  blockedAt: number | null;
  /** What has already been commanded, so `realise` can emit only changes. */
  commanded: {
    /** Epoch ms the pending timer is due at, or `null` if none is pending. */
    timerDueAt: number | null;
    status: SchedulerStatus | null;
  };
}

export type SchedulerEvent =
  | {
      type: "page-loaded";
      focused: boolean;
      /** Page visibility at load; assumed `true` when left out. */
      visible?: boolean;
      /** Whether the tab is active in its window at load; assumed `true` when left out. */
      active?: boolean;
      /** What the previous page of this tab persisted, or `null` on a fresh tab. */
      restored: PersistedSchedulerState | null;
    }
  | { type: "focus-changed"; focused: boolean }
  | { type: "visibility-changed"; visible: boolean }
  | { type: "tab-activity-changed"; active: boolean }
  | { type: "timer-fired" }
  | { type: "settings-changed"; settings: Partial<SchedulerSettings> }
  | { type: "pause-toggled"; paused: boolean }
  /** The adapter's answer to `check-blockers`: what the Blocker Detector found (empty when nothing blocks). */
  | { type: "blockers-checked"; reasons: readonly BlockerReason[] };

export type SchedulerCommand =
  | { type: "reload" }
  /** Start the single scheduler timer, replacing any pending one. */
  | { type: "schedule-timer"; delayMs: number }
  | { type: "cancel-timer" }
  /** Run the Blocker Detector and answer with a `blockers-checked` event. */
  | { type: "check-blockers" }
  | ({ type: "set-badge" } & SchedulerStatus)
  /** Store this for the next page load of the tab (see `PersistedSchedulerState`). */
  | { type: "persist"; state: PersistedSchedulerState };

export interface Transition {
  state: SchedulerState;
  commands: SchedulerCommand[];
}

/** What the tab should be doing right now. */
export type Plan =
  | { kind: "frozen" }
  | { kind: "halted"; status: SchedulerStatus }
  | { kind: "waiting"; dueAt: number; status: SchedulerStatus }
  | { kind: "due" };

/** A rule that stops refreshing: returns the status to show, or `null` to let refreshing go on. */
export type HaltRule = (state: SchedulerState) => SchedulerStatus | null;

export function initialSchedulerState(settings: SchedulerSettings): SchedulerState {
  return {
    phase: "starting",
    settings,
    focused: false,
    visible: true,
    active: true,
    persisted: { lastReloadAt: null },
    blockerCheck: "idle",
    blockedAt: null,
    commanded: { timerDueAt: null, status: null },
  };
}

export function transition(state: SchedulerState, event: SchedulerEvent, now: number): Transition {
  const applied = applyEvent(state, event, now);
  return realise(applied, plan(applied, now), now);
}

// Step 1 ----------------------------------------------------------------------

export function applyEvent(state: SchedulerState, event: SchedulerEvent, now: number): SchedulerState {
  switch (event.type) {
    case "page-loaded":
      return {
        ...state,
        phase: "running",
        focused: event.focused,
        visible: event.visible ?? true,
        active: event.active ?? true,
        persisted: { ...state.persisted, ...event.restored, lastReloadAt: event.restored?.lastReloadAt ?? now },
        // A new page has no timer and a fresh badge.
        commanded: { timerDueAt: null, status: null },
      };
    case "focus-changed":
      return { ...state, focused: event.focused };
    case "visibility-changed":
      return { ...state, visible: event.visible };
    case "tab-activity-changed":
      return { ...state, active: event.active };
    case "timer-fired":
      return { ...state, commanded: { ...state.commanded, timerDueAt: null } };
    case "settings-changed":
      return { ...state, settings: { ...state.settings, ...event.settings } };
    case "blockers-checked":
      // An answer nobody is waiting for any more (the plan changed meanwhile) is stale.
      if (state.blockerCheck !== "pending") return state;
      return event.reasons.length === 0
        ? { ...state, blockerCheck: "clear" }
        : { ...state, blockerCheck: "idle", blockedAt: now };
    case "pause-toggled":
      return { ...state, persisted: { ...state.persisted, paused: event.paused } };
  }
}

// Step 2 ----------------------------------------------------------------------

const haltWhilePaused: HaltRule = (state) => (state.persisted.paused ? { badge: "idle", reason: "paused" } : null);
const haltWhileFocused: HaltRule = (state) => (state.focused ? { badge: "idle", reason: "focused" } : null);

/** In "Current tab" mode only the visible, active tab of its window refreshes. */
const haltUnlessCurrentTab: HaltRule = (state) =>
  state.settings.mode === "current-tab" && !(state.visible && state.active)
    ? { badge: "idle", reason: "not-current-tab" }
    : null;

/** Checked in order; the first rule that halts wins. */
export const HALT_RULES: readonly HaltRule[] = [haltWhilePaused, haltWhileFocused, haltUnlessCurrentTab];

const POLLING: SchedulerStatus = { badge: "polling", reason: "polling" };
const BLOCKED: SchedulerStatus = { badge: "blocked", reason: "blocked" };

export function plan(state: SchedulerState, now: number): Plan {
  if (state.phase !== "running") return { kind: "frozen" };
  for (const rule of HALT_RULES) {
    const status = rule(state);
    if (status) return { kind: "halted", status };
  }
  const dueAt = nextDueAt(state);
  if (now >= dueAt) return { kind: "due" };
  return { kind: "waiting", dueAt, status: state.blockedAt === null ? POLLING : BLOCKED };
}

/** When the next reload is due, as epoch ms: an interval after the last reload, or after the last blocked tick. */
export function nextDueAt(state: SchedulerState): number {
  const { lastReloadAt } = state.persisted;
  const { intervalMs } = state.settings;
  const afterReload = lastReloadAt === null ? -Infinity : lastReloadAt + intervalMs;
  const afterBlocked = state.blockedAt === null ? -Infinity : state.blockedAt + intervalMs;
  return Math.max(afterReload, afterBlocked);
}

// Step 3 ----------------------------------------------------------------------

export function realise(state: SchedulerState, planned: Plan, now: number): Transition {
  switch (planned.kind) {
    case "frozen":
      return { state, commands: [] };
    case "due":
      return onDue(state, now);
    case "halted":
      // Whatever blocked the last tick gets a fresh check as soon as refreshing resumes.
      return sync({ ...state, blockedAt: null }, null, planned.status, now);
    case "waiting":
      return sync(state, planned.dueAt, planned.status, now);
  }
}

/** The reload is due: check for blockers first, and reload once nothing blocks. */
export function onDue(state: SchedulerState, now: number): Transition {
  if (state.blockerCheck === "pending") return { state, commands: [] };
  if (state.blockerCheck === "idle") {
    const commands: SchedulerCommand[] = [];
    if (state.commanded.timerDueAt !== null) commands.push({ type: "cancel-timer" });
    commands.push({ type: "check-blockers" });
    return { state: { ...state, blockerCheck: "pending", commanded: { ...state.commanded, timerDueAt: null } }, commands };
  }
  const persisted = { ...state.persisted, lastReloadAt: now };
  const commands: SchedulerCommand[] = [];
  if (state.commanded.timerDueAt !== null) commands.push({ type: "cancel-timer" });
  commands.push({ type: "persist", state: persisted }, { type: "reload" });
  return {
    state: { ...state, phase: "reloading", persisted, commanded: { ...state.commanded, timerDueAt: null } },
    commands,
  };
}

/** Brings the timer and badge in line with what the plan wants, emitting only changes. */
function sync(state: SchedulerState, timerDueAt: number | null, status: SchedulerStatus, now: number): Transition {
  const commands: SchedulerCommand[] = [];
  const { commanded } = state;
  if (timerDueAt !== commanded.timerDueAt) {
    commands.push(timerDueAt === null ? { type: "cancel-timer" } : { type: "schedule-timer", delayMs: timerDueAt - now });
  }
  if (commanded.status?.badge !== status.badge || commanded.status.reason !== status.reason) {
    commands.push({ type: "set-badge", ...status });
  }
  // Not due any more: an outstanding or passed blocker check no longer applies.
  return { state: { ...state, blockerCheck: "idle", commanded: { timerDueAt, status } }, commands };
}
