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
 *    A due plan runs `onDue`, which walks the pre-reload checks and then reloads.
 *
 * A due reload first asks the adapter to run the Blocker Detector
 * (`check-blockers`, #4). Once it answers `blockers-checked` with no reasons,
 * the adapter checks the server is reachable (`check-reachability`, #8) and
 * runs the Blocker Detector again, answering `reachability-checked`. The
 * reload goes ahead only if the tab is still due by then: focus, a pause or a
 * new blocker during the check aborts it, and the scheduler carries on.
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
  /** Reloads that failed in a row since the last board load; absent means none. */
  consecutiveFailures?: number;
  /**
   * Whether the user paused this tab from the popup. Optional so a restored
   * state without it keeps the current value (the background worker owns the
   * pause flag and the adapter merges it into `restored`).
   */
  paused?: boolean;
}

/** Why the tab is in its current status, alongside the badge colour. */
export type StatusReason =
  | "paused"
  | "focused"
  | "polling"
  | "not-current-tab"
  | "blocked"
  | "signed-out"
  | "reload-failed";

export interface SchedulerStatus {
  badge: BadgeState;
  reason: StatusReason;
  /** What blocks the reload, in Blocker Detector order; only with reason `blocked`. */
  blockers?: readonly BlockerReason[];
}

export interface SchedulerState {
  /**
   * `starting` until the first `page-loaded`; `reloading` once a reload was
   * commanded (the page is about to go away, so nothing more is emitted).
   */
  phase: "starting" | "running" | "reloading";
  settings: SchedulerSettings;
  /** Whether the page has DOM focus (`window` focus/blur). */
  focused: boolean;
  /**
   * Whether the tab's browser window is the focused Chrome window. The page
   * also loses DOM focus to the toolbar popup or the omnibox while its window
   * keeps focus, so the tab counts as unfocused only when both are false.
   */
  windowFocused: boolean;
  /** The page loaded in the tab is the sign-in page: the session has expired. */
  signedOut: boolean;
  /** Whether the page is visible (`document.visibilityState`). */
  visible: boolean;
  /** Whether the tab is the active tab of its window. */
  active: boolean;
  persisted: PersistedSchedulerState;
  /**
   * How far the due reload got through its checks: `idle` when none is
   * outstanding; `blockers-pending` once `check-blockers` was commanded;
   * `blockers-clear` when it answered with no reasons; `reachability-pending`
   * once `check-reachability` was commanded; `ready` when the server answered
   * and nothing blocks (the reload goes ahead if the tab is still due). Any
   * plan other than due resets it, so a late answer is ignored.
   */
  reloadCheck: "idle" | "blockers-pending" | "blockers-clear" | "reachability-pending" | "ready";
  /** The last tick skipped because something blocked the reload (when, and what blocked it), or `null`. */
  blocked: { at: number; reasons: readonly BlockerReason[] } | null;
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
      /** Which kind of page loaded; a board when omitted. */
      page?: LoadedPage;
      focused: boolean;
      /** Whether the tab's browser window is the focused Chrome window; assumed `false` when left out. */
      windowFocused?: boolean;
      /** Page visibility at load; assumed `true` when left out. */
      visible?: boolean;
      /** Whether the tab is active in its window at load; assumed `true` when left out. */
      active?: boolean;
      /** What the previous page of this tab persisted, or `null` on a fresh tab. */
      restored: PersistedSchedulerState | null;
    }
  /** The page gained or lost DOM focus. */
  | { type: "focus-changed"; focused: boolean }
  /** The tab's browser window became, or stopped being, the focused Chrome window. */
  | { type: "window-focus-changed"; focused: boolean }
  | { type: "visibility-changed"; visible: boolean }
  | { type: "tab-activity-changed"; active: boolean }
  | { type: "timer-fired" }
  | { type: "settings-changed"; settings: Partial<SchedulerSettings> }
  | { type: "pause-toggled"; paused: boolean }
  /** The adapter's answer to `check-blockers`: what the Blocker Detector found (empty when nothing blocks). */
  | { type: "blockers-checked"; reasons: readonly BlockerReason[] }
  /**
   * The adapter's answer to `check-reachability`: the server could not be
   * reached (the page stays), or it answered and the Blocker Detector, run
   * again, found `reasons` (empty when nothing blocks).
   */
  | { type: "reachability-checked"; reachable: false }
  | { type: "reachability-checked"; reachable: true; reasons: readonly BlockerReason[] };

/**
 * `board`: an issue board loaded. `sign-in`: the tab landed on the sign-in
 * page. `error`: the tab's board URL loaded an error page instead of a board.
 */
export type LoadedPage = "board" | "sign-in" | "error";

export type SchedulerCommand =
  | { type: "reload" }
  /** Start the single scheduler timer, replacing any pending one. */
  | { type: "schedule-timer"; delayMs: number }
  | { type: "cancel-timer" }
  /** Run the Blocker Detector and answer with a `blockers-checked` event. */
  | { type: "check-blockers" }
  /** Check the server is reachable, run the Blocker Detector again, and answer with a `reachability-checked` event. */
  | { type: "check-reachability" }
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
    windowFocused: false,
    signedOut: false,
    visible: true,
    active: true,
    persisted: { lastReloadAt: null },
    reloadCheck: "idle",
    blocked: null,
    commanded: { timerDueAt: null, status: null },
  };
}

export function transition(state: SchedulerState, event: SchedulerEvent, now: number): Transition {
  const applied = applyEvent(state, event, now);
  const result = realise(applied, plan(applied, now), now);
  // A new failure count is stored at once, so the backoff survives the error page being reloaded.
  if (failures(applied) !== failures(state) && !result.commands.some((c) => c.type === "persist")) {
    result.commands.unshift({ type: "persist", state: applied.persisted });
  }
  return result;
}

// Step 1 ----------------------------------------------------------------------

export function applyEvent(state: SchedulerState, event: SchedulerEvent, now: number): SchedulerState {
  switch (event.type) {
    case "page-loaded": {
      const { consecutiveFailures = 0, ...restored }: Partial<PersistedSchedulerState> = event.restored ?? {};
      const base = { ...state.persisted, ...restored, lastReloadAt: restored.lastReloadAt ?? now };
      return {
        ...state,
        phase: "running",
        focused: event.focused,
        windowFocused: event.windowFocused ?? false,
        signedOut: event.page === "sign-in",
        visible: event.visible ?? true,
        active: event.active ?? true,
        // An error page counts one more failure; any other page ends the run of failures.
        persisted: withFailures(base, event.page === "error" ? consecutiveFailures + 1 : 0),
        // A new page has no timer and a fresh badge.
        commanded: { timerDueAt: null, status: null },
      };
    }
    case "focus-changed":
      return { ...state, focused: event.focused };
    case "window-focus-changed":
      return { ...state, windowFocused: event.focused };
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
      if (state.reloadCheck !== "blockers-pending") return state;
      return event.reasons.length === 0 ? { ...state, reloadCheck: "blockers-clear" } : blockedBy(state, event.reasons, now);
    case "reachability-checked":
      if (state.reloadCheck !== "reachability-pending") return state;
      if (!event.reachable) {
        // The backoff runs from the failed check, so a slow timeout doesn't eat into it.
        const persisted = { ...state.persisted, lastReloadAt: now };
        return { ...state, reloadCheck: "idle", persisted: withFailures(persisted, failures(state) + 1) };
      }
      return event.reasons.length === 0 ? { ...state, reloadCheck: "ready" } : blockedBy(state, event.reasons, now);
    case "pause-toggled":
      return { ...state, persisted: { ...state.persisted, paused: event.paused } };
  }
}

function blockedBy(state: SchedulerState, reasons: readonly BlockerReason[], now: number): SchedulerState {
  return { ...state, reloadCheck: "idle", blocked: { at: now, reasons: [...reasons] } };
}

function failures(state: SchedulerState): number {
  return state.persisted.consecutiveFailures ?? 0;
}

function withFailures(persisted: PersistedSchedulerState, count: number): PersistedSchedulerState {
  const { consecutiveFailures: _dropped, ...rest } = persisted;
  return count > 0 ? { ...rest, consecutiveFailures: count } : rest;
}

// Step 2 ----------------------------------------------------------------------

const haltWhilePaused: HaltRule = (state) => (state.persisted.paused ? { badge: "idle", reason: "paused" } : null);
/** Focused unless the page is blurred and its browser window is not the focused window either. */
const haltWhileFocused: HaltRule = (state) =>
  state.focused || state.windowFocused ? { badge: "idle", reason: "focused" } : null;

/** In "Current tab" mode only the visible, active tab of its window refreshes. */
const haltUnlessCurrentTab: HaltRule = (state) =>
  state.settings.mode === "current-tab" && !(state.visible && state.active)
    ? { badge: "idle", reason: "not-current-tab" }
    : null;

const haltWhenSignedOut: HaltRule = (state) => (state.signedOut ? { badge: "error", reason: "signed-out" } : null);

/** Checked in order; the first rule that halts wins. A paused tab is idle regardless of other inputs (spec #1). */
export const HALT_RULES: readonly HaltRule[] = [haltWhilePaused, haltWhenSignedOut, haltWhileFocused, haltUnlessCurrentTab];

const POLLING: SchedulerStatus = { badge: "polling", reason: "polling" };
const FAILING: SchedulerStatus = { badge: "error", reason: "reload-failed" };

export function plan(state: SchedulerState, now: number): Plan {
  if (state.phase !== "running") return { kind: "frozen" };
  for (const rule of HALT_RULES) {
    const status = rule(state);
    if (status) return { kind: "halted", status: keepRedWhileFailing(state, status) };
  }
  const dueAt = nextDueAt(state);
  if (now >= dueAt) return { kind: "due" };
  return { kind: "waiting", dueAt, status: waitingStatus(state) };
}

/** A skipped (blocked) tick shows yellow until the next check, even while failures back off; otherwise failing reloads show red. */
function waitingStatus(state: SchedulerState): SchedulerStatus {
  if (state.blocked !== null) return { badge: "blocked", reason: "blocked", blockers: state.blocked.reasons };
  return failures(state) > 0 ? FAILING : POLLING;
}

/** A failing tab that stops for focus or tab activity keeps its red badge until a board loads; a pause still shows. */
function keepRedWhileFailing(state: SchedulerState, status: SchedulerStatus): SchedulerStatus {
  return failures(state) > 0 && status.badge === "idle" && status.reason !== "paused" ? FAILING : status;
}

/** Failed reloads back off up to this delay (or the interval, if that is longer). */
export const MAX_BACKOFF_MS = 5 * 60 * 1000;

/**
 * When the next reload is due, as epoch ms: a (backed-off) interval after the
 * last reload, or one interval after the last blocked tick, whichever is later.
 * After failures the interval doubles per failure, capped.
 */
export function nextDueAt(state: SchedulerState): number {
  const { lastReloadAt } = state.persisted;
  const { intervalMs } = state.settings;
  const backoff = Math.min(intervalMs * 2 ** failures(state), Math.max(MAX_BACKOFF_MS, intervalMs));
  const afterReload = lastReloadAt === null ? -Infinity : lastReloadAt + backoff;
  const afterBlocked = state.blocked === null ? -Infinity : state.blocked.at + intervalMs;
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
      return sync({ ...state, blocked: null }, null, planned.status, now);
    case "waiting":
      return sync(state, planned.dueAt, planned.status, now);
  }
}

/** The reload is due: run the next pre-reload check, and reload once they have all passed. */
export function onDue(state: SchedulerState, now: number): Transition {
  const step = DUE_STEPS[state.reloadCheck];
  if (step === null) return { state, commands: [] }; // An answer is outstanding.
  const commands: SchedulerCommand[] = [];
  if (state.commanded.timerDueAt !== null) commands.push({ type: "cancel-timer" });
  const commanded = { ...state.commanded, timerDueAt: null };
  if (step !== "reload") {
    commands.push({ type: step.command });
    return { state: { ...state, reloadCheck: step.next, commanded }, commands };
  }
  const persisted = { ...state.persisted, lastReloadAt: now };
  commands.push({ type: "persist", state: persisted }, { type: "reload" });
  return {
    state: { ...state, phase: "reloading", persisted, reloadCheck: "idle", blocked: null, commanded },
    commands,
  };
}

/** What a due plan does at each check stage: command the next check, wait (`null`), or reload. */
const DUE_STEPS: Record<
  SchedulerState["reloadCheck"],
  { command: "check-blockers" | "check-reachability"; next: SchedulerState["reloadCheck"] } | "reload" | null
> = {
  idle: { command: "check-blockers", next: "blockers-pending" },
  "blockers-pending": null,
  "blockers-clear": { command: "check-reachability", next: "reachability-pending" },
  "reachability-pending": null,
  ready: "reload",
};

/** Brings the timer and badge in line with what the plan wants, emitting only changes. */
function sync(state: SchedulerState, timerDueAt: number | null, status: SchedulerStatus, now: number): Transition {
  const commands: SchedulerCommand[] = [];
  const { commanded } = state;
  if (timerDueAt !== commanded.timerDueAt) {
    commands.push(timerDueAt === null ? { type: "cancel-timer" } : { type: "schedule-timer", delayMs: timerDueAt - now });
  }
  if (!sameStatus(commanded.status, status)) {
    commands.push({ type: "set-badge", ...status });
  }
  // Not due any more: an outstanding or passed blocker check no longer applies.
  return { state: { ...state, reloadCheck: "idle", commanded: { timerDueAt, status } }, commands };
}

function sameStatus(a: SchedulerStatus | null, b: SchedulerStatus): boolean {
  if (a === null || a.badge !== b.badge || a.reason !== b.reason) return false;
  const [x = [], y = []] = [a.blockers, b.blockers];
  return x.length === y.length && x.every((reason, i) => reason === y[i]);
}
