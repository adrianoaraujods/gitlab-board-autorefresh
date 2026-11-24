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
 *    A due plan runs `onDue`, which reloads.
 *
 * Extending (tickets #4–#8): add an event to `SchedulerEvent` and handle it in
 * `applyEvent`; add input fields to `SchedulerState`; add a halt rule to
 * `HALT_RULES`; adjust `nextDueAt` (backoff, skipped ticks); route `onDue`
 * through a blocker check. Add commands to `SchedulerCommand`.
 */
import type { BadgeState } from "./badge";

export interface SchedulerSettings {
  intervalMs: number;
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
}

/** Why the tab is in its current status, alongside the badge colour. */
export type StatusReason = "focused" | "polling" | "signed-out" | "reload-failed";

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
  /** The page loaded in the tab is the sign-in page: the session has expired. */
  signedOut: boolean;
  persisted: PersistedSchedulerState;
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
      /** What the previous page of this tab persisted, or `null` on a fresh tab. */
      restored: PersistedSchedulerState | null;
    }
  | { type: "focus-changed"; focused: boolean }
  | { type: "timer-fired" }
  /** The commanded reload could not be carried out (for example, the server is unreachable); the page stays. */
  | { type: "reload-failed" }
  | { type: "settings-changed"; settings: Partial<SchedulerSettings> };

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
    signedOut: false,
    persisted: { lastReloadAt: null },
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
        signedOut: event.page === "sign-in",
        // An error page counts one more failure; any other page ends the run of failures.
        persisted: withFailures(base, event.page === "error" ? consecutiveFailures + 1 : 0),
        // A new page has no timer and a fresh badge.
        commanded: { timerDueAt: null, status: null },
      };
    }
    case "focus-changed":
      return { ...state, focused: event.focused };
    case "timer-fired":
      return { ...state, commanded: { ...state.commanded, timerDueAt: null } };
    case "reload-failed":
      return { ...state, phase: "running", persisted: withFailures(state.persisted, failures(state) + 1) };
    case "settings-changed":
      return { ...state, settings: { ...state.settings, ...event.settings } };
  }
}

function failures(state: SchedulerState): number {
  return state.persisted.consecutiveFailures ?? 0;
}

function withFailures(persisted: PersistedSchedulerState, count: number): PersistedSchedulerState {
  const { consecutiveFailures: _dropped, ...rest } = persisted;
  return count > 0 ? { ...rest, consecutiveFailures: count } : rest;
}

// Step 2 ----------------------------------------------------------------------

const haltWhileFocused: HaltRule = (state) => (state.focused ? { badge: "idle", reason: "focused" } : null);

const POLLING: SchedulerStatus = { badge: "polling", reason: "polling" };
const FAILING: SchedulerStatus = { badge: "error", reason: "reload-failed" };

const haltWhenSignedOut: HaltRule = (state) => (state.signedOut ? { badge: "error", reason: "signed-out" } : null);

/** Focus stops retries, but the badge stays red until a board loads. */
const haltWhileFocusedAfterFailure: HaltRule = (state) => (state.focused && failures(state) > 0 ? FAILING : null);

/** Checked in order; the first rule that halts wins. */
export const HALT_RULES: readonly HaltRule[] = [haltWhenSignedOut, haltWhileFocusedAfterFailure, haltWhileFocused];

export function plan(state: SchedulerState, now: number): Plan {
  if (state.phase !== "running") return { kind: "frozen" };
  for (const rule of HALT_RULES) {
    const status = rule(state);
    if (status) return { kind: "halted", status };
  }
  const dueAt = nextDueAt(state);
  return now >= dueAt ? { kind: "due" } : { kind: "waiting", dueAt, status: failures(state) > 0 ? FAILING : POLLING };
}

/** Failed reloads back off up to this delay (or the interval, if that is longer). */
export const MAX_BACKOFF_MS = 5 * 60 * 1000;

/** When the next reload is due, as epoch ms. After failures the interval doubles per failure, capped. */
export function nextDueAt(state: SchedulerState): number {
  const { lastReloadAt } = state.persisted;
  if (lastReloadAt === null) return -Infinity;
  const { intervalMs } = state.settings;
  const backoff = Math.min(intervalMs * 2 ** failures(state), Math.max(MAX_BACKOFF_MS, intervalMs));
  return lastReloadAt + backoff;
}

// Step 3 ----------------------------------------------------------------------

export function realise(state: SchedulerState, planned: Plan, now: number): Transition {
  switch (planned.kind) {
    case "frozen":
      return { state, commands: [] };
    case "due":
      return onDue(state, now);
    case "halted":
      return sync(state, null, planned.status, now);
    case "waiting":
      return sync(state, planned.dueAt, planned.status, now);
  }
}

/** The reload is due: reload the page. */
export function onDue(state: SchedulerState, now: number): Transition {
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
  return { state: { ...state, commanded: { timerDueAt, status } }, commands };
}
