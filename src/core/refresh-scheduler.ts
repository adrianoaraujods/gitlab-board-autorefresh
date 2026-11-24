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
 * Smart detection (#11): with `detection: "smart"` on a loaded board, a due
 * tick first asks the adapter whether the board changed (`check-changes`,
 * answered `changes-checked` with the Change Detector's result). Nothing
 * changed: no reload, and the next check is an interval later. A change, a
 * response detection can't read or a failed request: the v1 checks above,
 * then the reload. The baseline fingerprint is taken as soon as a board loads
 * and kept in the persisted state.
 *
 * Extending: add an event to `SchedulerEvent` and handle it in
 * `applyEvent`; add input fields to `SchedulerState`; add a halt rule to
 * `HALT_RULES`; adjust `nextDueAt` (backoff). Add commands to
 * `SchedulerCommand`. New detection results (#13–#15) are handled in
 * `changesChecked`; a different way to apply a change (#17) replaces the
 * `reload` step of `dueStep`.
 */
import type { BadgeState } from "./badge";
import type { BlockerReason } from "./blocker-detector";
import type { BoardFingerprint, ChangeDetection } from "./change-detector";

/**
 * Which board tabs refresh: only the visible, active tab of each window
 * ("Current tab", the default), or every board tab ("All tabs").
 */
export type TabMode = "current-tab" | "all-tabs";

/** Reads a stored or submitted tab mode; anything but "all-tabs" is the default, "current-tab". */
export function normalizeTabMode(value: unknown): TabMode {
  return value === "all-tabs" ? "all-tabs" : "current-tab";
}

/**
 * How a due tick refreshes (#11): "smart" first asks the Change Detector
 * whether the board changed and reloads only if it did; "always-reload" is
 * the v1 blind reload every interval.
 */
export type Detection = "smart" | "always-reload";

/** Reads a stored or submitted detection setting; anything but "always-reload" is the default, "smart". */
export function normalizeDetection(value: unknown): Detection {
  return value === "always-reload" ? "always-reload" : "smart";
}

export interface SchedulerSettings {
  intervalMs: number;
  mode: TabMode;
  /** Left out: "always-reload" (v1). The extension's settings default to "smart". */
  detection?: Detection;
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
  /**
   * Smart detection: the board's fingerprint the next check compares with;
   * absent until one is taken. A board load drops the restored one and takes
   * a fresh one, since the reloaded page shows the board as it is now.
   */
  baseline?: BoardFingerprint;
  /**
   * Smart detection: changes found while the window was focused, waiting to
   * be applied once it is not. A board load drops it (the load applies them).
   */
  pending?: { changedCount: number };
}

/** Why the tab is in its current status, alongside the badge colour. */
export type StatusReason =
  | "paused"
  | "focused"
  | "polling"
  | "not-current-tab"
  | "blocked"
  | "signed-out"
  | "reload-failed"
  | "updates-available";

export interface SchedulerStatus {
  badge: BadgeState;
  reason: StatusReason;
  /** What blocks the reload, in Blocker Detector order; only with reason `blocked`. */
  blockers?: readonly BlockerReason[];
  /** Cards changed since the board loaded; only with reason `updates-available`. */
  changedCount?: number;
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
  /** The page loaded in the tab is a board (not the sign-in or an error page): smart detection applies. */
  boardLoaded: boolean;
  /** Whether the page is visible (`document.visibilityState`). */
  visible: boolean;
  /** Whether the tab is the active tab of its window. */
  active: boolean;
  persisted: PersistedSchedulerState;
  /** How far the due tick got through its checks (see `ReloadCheck`). */
  reloadCheck: ReloadCheck;
  /**
   * Smart detection: a `check-changes` was commanded only to take the
   * baseline (not for a due tick), and its answer is outstanding.
   */
  baselinePending: boolean;
  /** Smart detection: epoch ms of the last check that found nothing to reload, or `null`. */
  lastCheckAt: number | null;
  /** The last tick skipped because something blocked the reload (when, and what blocked it), or `null`. */
  blocked: { at: number; reasons: readonly BlockerReason[] } | null;
  /** What has already been commanded, so `realise` can emit only changes. */
  commanded: {
    /** Epoch ms the pending timer is due at, or `null` if none is pending. */
    timerDueAt: number | null;
    status: SchedulerStatus | null;
  };
}

/**
 * How far the due tick got through its checks: `idle` when none is
 * outstanding; in smart detection, `changes-pending` once `check-changes`
 * was commanded and `changed` when the board changed (or detection could not
 * tell), so a reload goes ahead; `blockers-pending` once `check-blockers` was
 * commanded; `blockers-clear` when it answered with no reasons;
 * `reachability-pending` once `check-reachability` was commanded; `ready`
 * when the server answered and nothing blocks (the reload goes ahead if the
 * tab is still due). Any plan other than due resets it, so a late answer is
 * ignored.
 */
export type ReloadCheck =
  | "idle"
  | "changes-pending"
  | "changed"
  | "blockers-pending"
  | "blockers-clear"
  | "reachability-pending"
  | "ready";

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
  | { type: "reachability-checked"; reachable: true; reasons: readonly BlockerReason[] }
  /**
   * The adapter's answer to `check-changes`: the request failed (network
   * error, timeout, an HTTP error), or the Change Detector's result.
   */
  | { type: "changes-checked"; reachable: false }
  | { type: "changes-checked"; reachable: true; detection: ChangeDetection };

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
  /**
   * Smart detection: fetch the board's fingerprint, compare it with
   * `baseline` (`null`: none yet, the answer becomes the baseline) and answer
   * with a `changes-checked` event.
   */
  | { type: "check-changes"; baseline: BoardFingerprint | null }
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
    boardLoaded: false,
    visible: true,
    active: true,
    persisted: { lastReloadAt: null },
    reloadCheck: "idle",
    baselinePending: false,
    lastCheckAt: null,
    blocked: null,
    commanded: { timerDueAt: null, status: null },
  };
}

export function transition(state: SchedulerState, event: SchedulerEvent, now: number): Transition {
  const applied = applyEvent(state, event, now);
  const result = takeBaselineIfMissing(realise(applied, plan(applied, now), now), event);
  // A new failure count is stored at once, so the backoff survives the error page being reloaded.
  const storedChanged =
    failures(applied) !== failures(state) || applied.persisted.pending?.changedCount !== state.persisted.pending?.changedCount;
  if (storedChanged && !result.commands.some((c) => c.type === "persist")) {
    result.commands.unshift({ type: "persist", state: applied.persisted });
  }
  return result;
}

/**
 * Smart detection takes the baseline as soon as a board loads (or detection is
 * switched to smart), whatever the plan, so a change made while the window is
 * focused still shows up at the first check after it. A due check already
 * takes it.
 */
function takeBaselineIfMissing(result: Transition, event: SchedulerEvent): Transition {
  const { state } = result;
  if (event.type !== "page-loaded" && event.type !== "settings-changed") return result;
  if (state.phase !== "running" || !detecting(state) || state.persisted.baseline !== undefined) return result;
  if (state.baselinePending || state.reloadCheck === "changes-pending") return result;
  return {
    state: { ...state, baselinePending: true },
    commands: [...result.commands, { type: "check-changes", baseline: null }],
  };
}

/** Whether due ticks go through smart detection: the setting is on and a board is loaded. */
function detecting(state: SchedulerState): boolean {
  return state.settings.detection === "smart" && state.boardLoaded;
}

// Step 1 ----------------------------------------------------------------------

export function applyEvent(state: SchedulerState, event: SchedulerEvent, now: number): SchedulerState {
  switch (event.type) {
    case "page-loaded": {
      const { consecutiveFailures = 0, ...restored }: Partial<PersistedSchedulerState> = event.restored ?? {};
      const page = event.page ?? "board";
      const merged = { ...state.persisted, ...restored, lastReloadAt: restored.lastReloadAt ?? now };
      // A full board load resets the baseline; an error or sign-in page keeps it.
      const { baseline: _dropped, pending: _applied, ...withoutBaseline } = merged;
      const base = page === "board" ? withoutBaseline : merged;
      return {
        ...state,
        phase: "running",
        focused: event.focused,
        windowFocused: event.windowFocused ?? false,
        signedOut: page === "sign-in",
        boardLoaded: page === "board",
        baselinePending: false,
        lastCheckAt: null,
        visible: event.visible ?? true,
        active: event.active ?? true,
        // An error page counts one more failure; any other page ends the run of failures.
        persisted: withFailures(base, page === "error" ? consecutiveFailures + 1 : 0),
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
    case "changes-checked":
      return changesChecked(state, event, now);
  }
}

function changesChecked(
  state: SchedulerState,
  event: Extract<SchedulerEvent, { type: "changes-checked" }>,
  now: number,
): SchedulerState {
  const detection = event.reachable ? event.detection : null;
  if (state.baselinePending) {
    // Only taking the baseline: no timing or reload decision hangs on it.
    const taken = detection !== null && detection.kind !== "invalid";
    const persisted = taken ? { ...state.persisted, baseline: detection.fingerprint } : state.persisted;
    return { ...state, baselinePending: false, persisted };
  }
  if (state.reloadCheck !== "changes-pending") return state;
  switch (detection?.kind) {
    case "unchanged": {
      // The server answered, so earlier failures are over; the next check is an interval from now.
      const { pending: _gone, ...rest } = state.persisted;
      const persisted = withFailures({ ...rest, baseline: detection.fingerprint }, 0);
      return { ...state, reloadCheck: "idle", lastCheckAt: now, blocked: null, persisted };
    }
    case "remote":
      if (isFocused(state)) {
        // Never reload a focused board: remember the change and keep the old baseline, so counts add up.
        const persisted = withFailures({ ...state.persisted, pending: { changedCount: detection.changedCount } }, 0);
        return { ...state, reloadCheck: "idle", lastCheckAt: now, persisted };
      }
      // Keep the old baseline: if the reload is blocked, the next check still sees the change.
      return { ...state, reloadCheck: "changed", persisted: withFailures(state.persisted, 0) };
    default:
      // Focused: nothing to apply, just look again an interval later.
      if (isFocused(state)) return { ...state, reloadCheck: "idle", lastCheckAt: now };
      // A failed request or a response detection can't read: reload like v1. A failed
      // request then fails the reachability check too, and backs off.
      return { ...state, reloadCheck: "changed" };
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
const haltWhileFocused: HaltRule = (state) => (isFocused(state) ? FOCUSED : null);

function isFocused(state: SchedulerState): boolean {
  return state.focused || state.windowFocused;
}

const FOCUSED: SchedulerStatus = { badge: "idle", reason: "focused" };

/** What a focused board shows: the blue updates badge while changes wait, otherwise idle. */
function focusedStatus(state: SchedulerState): SchedulerStatus {
  const pending = state.persisted.pending;
  if (pending === undefined) return FOCUSED;
  return { badge: "updates", reason: "updates-available", changedCount: pending.changedCount };
}

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
    if (status === FOCUSED && detecting(state)) return planFocusedChecks(state, now);
    if (status) return { kind: "halted", status: keepRedWhileFailing(state, status) };
  }
  const dueAt = nextDueAt(state);
  if (now >= dueAt) return { kind: "due" };
  return { kind: "waiting", dueAt, status: waitingStatus(state) };
}

/** A focused board in smart detection keeps checking on schedule, but never reloads. */
function planFocusedChecks(state: SchedulerState, now: number): Plan {
  const dueAt = nextDueAt(state);
  if (now >= dueAt) return { kind: "due" };
  return { kind: "waiting", dueAt, status: keepRedWhileFailing(state, focusedStatus(state)) };
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
 * last reload, one interval after the last smart check that found nothing to
 * reload, or one interval after the last blocked tick, whichever is latest.
 * After failures the interval doubles per failure, capped.
 */
export function nextDueAt(state: SchedulerState): number {
  const { lastReloadAt } = state.persisted;
  const { intervalMs } = state.settings;
  const backoff = Math.min(intervalMs * 2 ** failures(state), Math.max(MAX_BACKOFF_MS, intervalMs));
  // Waiting changes are applied at once when the window is left, not an interval after the last check.
  const applying = state.persisted.pending !== undefined && !isFocused(state);
  const afterReload = lastReloadAt === null || (applying && failures(state) === 0) ? -Infinity : lastReloadAt + backoff;
  const afterCheck = state.lastCheckAt === null || applying ? -Infinity : state.lastCheckAt + intervalMs;
  const afterBlocked = state.blocked === null ? -Infinity : state.blocked.at + intervalMs;
  return Math.max(afterReload, afterCheck, afterBlocked);
}

// Step 3 ----------------------------------------------------------------------

const FOCUSED_CHECKS: readonly ReloadCheck[] = ["idle", "changes-pending"];

export function realise(state: SchedulerState, planned: Plan, now: number): Transition {
  switch (planned.kind) {
    case "frozen":
      return { state, commands: [] };
    case "due":
      // A focused board only checks: drop any apply that was under way when it got focus.
      return onDue(isFocused(state) && !FOCUSED_CHECKS.includes(state.reloadCheck) ? { ...state, reloadCheck: "idle" } : state, now);
    case "halted":
      // Whatever blocked the last tick gets a fresh check as soon as refreshing resumes.
      return sync({ ...state, blocked: null }, null, planned.status, now);
    case "waiting":
      return sync(state, planned.dueAt, planned.status, now);
  }
}

/** The reload is due: run the next pre-reload check, and reload once they have all passed. */
export function onDue(state: SchedulerState, now: number): Transition {
  // A baseline check is outstanding: its answer decides nothing, but wait for it so the due check compares with it.
  if (state.baselinePending) return { state, commands: [] };
  const step = dueStep(state);
  if (step === null) return { state, commands: [] }; // An answer is outstanding.
  const commands: SchedulerCommand[] = [];
  if (state.commanded.timerDueAt !== null) commands.push({ type: "cancel-timer" });
  const commanded = { ...state.commanded, timerDueAt: null };
  if (step !== "reload") {
    commands.push(step.command);
    return { state: { ...state, reloadCheck: step.next, commanded }, commands };
  }
  const { pending: _applied, ...kept } = state.persisted;
  const persisted = { ...kept, lastReloadAt: now };
  commands.push({ type: "persist", state: persisted }, { type: "reload" });
  return {
    state: { ...state, phase: "reloading", persisted, reloadCheck: "idle", blocked: null, commanded },
    commands,
  };
}

type DueStep = { command: SchedulerCommand; next: ReloadCheck } | "reload" | null;

/**
 * What a due plan does at each check stage: command the next check, wait
 * (`null`), or reload. In smart detection a due tick first asks whether the
 * board changed; `changed` then goes through the same checks as a v1 tick.
 */
function dueStep(state: SchedulerState): DueStep {
  // Changes found while focused are known: apply them without asking again.
  if (state.reloadCheck === "idle" && state.persisted.pending !== undefined && !isFocused(state)) return DUE_STEPS.changed;
  if (state.reloadCheck === "idle" && detecting(state)) {
    return { command: { type: "check-changes", baseline: state.persisted.baseline ?? null }, next: "changes-pending" };
  }
  return DUE_STEPS[state.reloadCheck];
}

const DUE_STEPS: Record<ReloadCheck, DueStep> = {
  idle: { command: { type: "check-blockers" }, next: "blockers-pending" },
  "changes-pending": null,
  changed: { command: { type: "check-blockers" }, next: "blockers-pending" },
  "blockers-pending": null,
  "blockers-clear": { command: { type: "check-reachability" }, next: "reachability-pending" },
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
  if (a === null || a.badge !== b.badge || a.reason !== b.reason || a.changedCount !== b.changedCount) return false;
  const [x = [], y = []] = [a.blockers, b.blockers];
  return x.length === y.length && x.every((reason, i) => reason === y[i]);
}
