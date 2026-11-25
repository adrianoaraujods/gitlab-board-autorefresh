import { describe, expect, it } from "vitest";
import type { BoardFingerprint, ChangeDetection } from "./change-detector";
import {
  initialSchedulerState,
  normalizeDetection,
  normalizeSafetyNetMinutes,
  normalizeTabMode,
  transition,
  type PersistedSchedulerState,
  type SchedulerCommand,
  type SchedulerEvent,
  type Detection,
  type SchedulerState,
  type TabMode,
} from "./refresh-scheduler";

const SECOND = 1000;
const INTERVAL = 30 * SECOND;
/** An arbitrary wall-clock start, so tests never depend on `now` being 0. */
const T0 = 1_700_000_000_000;

/** The adapter's answer when the Blocker Detector finds nothing in the way. */
const NOTHING_BLOCKING: SchedulerEvent = { type: "blockers-checked", reasons: [] };

/** Once nothing blocks, the scheduler checks the server is reachable before reloading. */
const CHECK_REACHABILITY: SchedulerCommand[] = [{ type: "check-reachability" }];

/** The adapter's answer when the server answered and the second blocker check found nothing. */
const REACHABLE: SchedulerEvent = { type: "reachability-checked", reachable: true, reasons: [] };

/** The adapter's answer when the server could not be reached: the page stays. */
const UNREACHABLE: SchedulerEvent = { type: "reachability-checked", reachable: false };

/** The commands that reload the page, recording `at` as the last reload. */
function reloadAt(at: number): SchedulerCommand[] {
  return [{ type: "persist", state: { lastReloadAt: at } }, { type: "reload" }];
}

/**
 * Feeds events into the scheduler one at a time, threading state through, and
 * returns the commands each event produced. Tests only look at commands.
 */
function scheduler(intervalMs = INTERVAL, mode: TabMode = "current-tab", detection?: Detection, safetyNetMinutes?: number) {
  let state: SchedulerState = initialSchedulerState({
    intervalMs,
    mode,
    ...(detection && { detection }),
    ...(safetyNetMinutes !== undefined && { safetyNetMinutes }),
  });
  return {
    send(event: SchedulerEvent, at: number): SchedulerCommand[] {
      const result = transition(state, event, at);
      state = result.state;
      return result.commands;
    },
  };
}

describe("Refresh Scheduler", () => {
  describe("while the window is focused", () => {
    it("is idle with no timer when a board loads focused", () => {
      const s = scheduler();
      expect(s.send({ type: "page-loaded", focused: true, restored: null }, T0)).toEqual([
        { type: "set-badge", badge: "idle", reason: "focused" },
      ]);
    });
  });

  describe("when the window loses focus", () => {
    it("reloads right away if more than the interval has passed since the last reload", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: true, restored: null }, T0);
      expect(s.send({ type: "focus-changed", focused: false }, T0 + 5 * 60 * SECOND)).toEqual([
        { type: "check-blockers" },
      ]);
      expect(s.send(NOTHING_BLOCKING, T0 + 5 * 60 * SECOND)).toEqual(CHECK_REACHABILITY);
      expect(s.send(REACHABLE, T0 + 5 * 60 * SECOND)).toEqual(reloadAt(T0 + 5 * 60 * SECOND));
    });

    it("waits out the rest of the interval if the last reload was recent", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: true, restored: null }, T0);
      expect(s.send({ type: "focus-changed", focused: false }, T0 + 12 * SECOND)).toEqual([
        { type: "schedule-timer", delayMs: 18 * SECOND },
        { type: "set-badge", badge: "polling", reason: "polling" },
      ]);
    });
  });

  describe("while the window stays unfocused", () => {
    it("reloads when the timer fires", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: true, restored: null }, T0);
      s.send({ type: "focus-changed", focused: false }, T0 + 12 * SECOND);
      expect(s.send({ type: "timer-fired" }, T0 + 30 * SECOND)).toEqual([{ type: "check-blockers" }]);
      expect(s.send(NOTHING_BLOCKING, T0 + 30 * SECOND)).toEqual(CHECK_REACHABILITY);
      expect(s.send(REACHABLE, T0 + 30 * SECOND)).toEqual(reloadAt(T0 + 30 * SECOND));
    });

    it("keeps reloading every interval across page reloads, timed from the last reload", () => {
      const s = scheduler();
      // A previous page of this tab reloaded at T0; the reloaded page comes up unfocused 2s later.
      expect(s.send({ type: "page-loaded", focused: false, restored: { lastReloadAt: T0 } }, T0 + 2 * SECOND)).toEqual([
        { type: "schedule-timer", delayMs: 28 * SECOND },
        { type: "set-badge", badge: "polling", reason: "polling" },
      ]);
      expect(s.send({ type: "timer-fired" }, T0 + 30 * SECOND)).toEqual([{ type: "check-blockers" }]);
      expect(s.send(NOTHING_BLOCKING, T0 + 30 * SECOND)).toEqual(CHECK_REACHABILITY);
      expect(s.send(REACHABLE, T0 + 30 * SECOND)).toEqual(reloadAt(T0 + 30 * SECOND));

      const next = scheduler();
      expect(
        next.send({ type: "page-loaded", focused: false, restored: { lastReloadAt: T0 + 30 * SECOND } }, T0 + 31 * SECOND),
      ).toEqual([
        { type: "schedule-timer", delayMs: 29 * SECOND },
        { type: "set-badge", badge: "polling", reason: "polling" },
      ]);
    });

    it("reloads straight away when a page loads unfocused long after the last reload", () => {
      const s = scheduler();
      expect(s.send({ type: "page-loaded", focused: false, restored: { lastReloadAt: T0 } }, T0 + 45 * SECOND)).toEqual([
        { type: "check-blockers" },
      ]);
      expect(s.send(NOTHING_BLOCKING, T0 + 45 * SECOND)).toEqual(CHECK_REACHABILITY);
      expect(s.send(REACHABLE, T0 + 45 * SECOND)).toEqual(reloadAt(T0 + 45 * SECOND));
    });

    it("counts a fresh tab's first load as its last reload", () => {
      const s = scheduler();
      expect(s.send({ type: "page-loaded", focused: false, restored: null }, T0)).toEqual([
        { type: "schedule-timer", delayMs: INTERVAL },
        { type: "set-badge", badge: "polling", reason: "polling" },
      ]);
    });

    it("re-arms the timer for the remainder if it fires early", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: false, restored: null }, T0);
      expect(s.send({ type: "timer-fired" }, T0 + INTERVAL - 5)).toEqual([{ type: "schedule-timer", delayMs: 5 }]);
    });

    it("emits nothing after a reload until the next page loads", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: false, restored: { lastReloadAt: T0 } }, T0 + 45 * SECOND);
      s.send(NOTHING_BLOCKING, T0 + 45 * SECOND);
      s.send(REACHABLE, T0 + 45 * SECOND);
      expect(s.send({ type: "focus-changed", focused: true }, T0 + 46 * SECOND)).toEqual([]);
      expect(s.send({ type: "timer-fired" }, T0 + 90 * SECOND)).toEqual([]);
    });
  });

  describe("before each reload", () => {
    it("skips the reload while something blocks it, turns the badge yellow and tries again an interval later", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: false, restored: null }, T0);
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      expect(s.send({ type: "blockers-checked", reasons: ["unsaved-input"] }, T0 + INTERVAL)).toEqual([
        { type: "schedule-timer", delayMs: INTERVAL },
        { type: "set-badge", badge: "blocked", reason: "blocked", blockers: ["unsaved-input"] },
      ]);
    });

    it("reports what blocks the reload, and updates the badge status when that changes", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: false, restored: null }, T0);
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      s.send({ type: "blockers-checked", reasons: ["sidebar-open"] }, T0 + INTERVAL);
      s.send({ type: "timer-fired" }, T0 + 2 * INTERVAL);
      expect(s.send({ type: "blockers-checked", reasons: ["overlay-open", "dragging"] }, T0 + 2 * INTERVAL)).toEqual([
        { type: "schedule-timer", delayMs: INTERVAL },
        { type: "set-badge", badge: "blocked", reason: "blocked", blockers: ["overlay-open", "dragging"] },
      ]);
    });

    it("reloads on a later tick once nothing blocks any more", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: false, restored: null }, T0);
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      s.send({ type: "blockers-checked", reasons: ["sidebar-open"] }, T0 + INTERVAL);
      expect(s.send({ type: "timer-fired" }, T0 + 2 * INTERVAL)).toEqual([{ type: "check-blockers" }]);
      expect(s.send({ type: "blockers-checked", reasons: ["sidebar-open"] }, T0 + 2 * INTERVAL)).toEqual([
        { type: "schedule-timer", delayMs: INTERVAL },
      ]);
      expect(s.send({ type: "timer-fired" }, T0 + 3 * INTERVAL)).toEqual([{ type: "check-blockers" }]);
      expect(s.send(NOTHING_BLOCKING, T0 + 3 * INTERVAL)).toEqual(CHECK_REACHABILITY);
      expect(s.send(REACHABLE, T0 + 3 * INTERVAL)).toEqual(reloadAt(T0 + 3 * INTERVAL));
    });

    it("checks again right away when the window loses focus after the user came back", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: false, restored: null }, T0);
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      s.send({ type: "blockers-checked", reasons: ["unsaved-input"] }, T0 + INTERVAL);
      expect(s.send({ type: "focus-changed", focused: true }, T0 + INTERVAL + 5 * SECOND)).toEqual([
        { type: "cancel-timer" },
        { type: "set-badge", badge: "idle", reason: "focused" },
      ]);
      expect(s.send({ type: "focus-changed", focused: false }, T0 + INTERVAL + 9 * SECOND)).toEqual([
        { type: "check-blockers" },
      ]);
    });

    it("checks again right away when a blocked tab is hidden and shown again", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: false, restored: null }, T0);
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      s.send({ type: "blockers-checked", reasons: ["overlay-open"] }, T0 + INTERVAL);
      s.send({ type: "visibility-changed", visible: false }, T0 + INTERVAL + SECOND);
      expect(s.send({ type: "visibility-changed", visible: true }, T0 + INTERVAL + 2 * SECOND)).toEqual([
        { type: "check-blockers" },
      ]);
    });

    it("ignores a check that answers after the window regained focus", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: false, restored: null }, T0);
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      s.send({ type: "focus-changed", focused: true }, T0 + INTERVAL);
      expect(s.send(NOTHING_BLOCKING, T0 + INTERVAL)).toEqual([]);
      // The next blur runs a fresh check rather than reusing the stale answer.
      expect(s.send({ type: "focus-changed", focused: false }, T0 + INTERVAL + SECOND)).toEqual([
        { type: "check-blockers" },
      ]);
    });
  });

  describe("when the page loses DOM focus but its browser window keeps focus (toolbar popup, omnibox)", () => {
    it("stays idle", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: true, windowFocused: true, restored: null }, T0);
      expect(s.send({ type: "focus-changed", focused: false }, T0 + 5 * 60 * SECOND)).toEqual([]);
    });

    it("reloads once the browser window loses focus too", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: true, windowFocused: true, restored: null }, T0);
      s.send({ type: "focus-changed", focused: false }, T0 + 5 * 60 * SECOND);
      expect(s.send({ type: "window-focus-changed", focused: false }, T0 + 5 * 60 * SECOND)).toEqual([
        { type: "check-blockers" },
      ]);
    });

    it("is idle when a page loads blurred in the focused browser window", () => {
      const s = scheduler();
      expect(s.send({ type: "page-loaded", focused: false, windowFocused: true, restored: null }, T0)).toEqual([
        { type: "set-badge", badge: "idle", reason: "focused" },
      ]);
    });

    it("goes idle when the blurred page's browser window becomes the focused window", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: false, windowFocused: false, restored: null }, T0);
      expect(s.send({ type: "window-focus-changed", focused: true }, T0 + 10 * SECOND)).toEqual([
        { type: "cancel-timer" },
        { type: "set-badge", badge: "idle", reason: "focused" },
      ]);
    });
  });

  describe("while the server's reachability is being checked", () => {
    /** Loads a board unfocused with the interval passed, and gets it to the reachability check. */
    function checkingReachability() {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: false, restored: { lastReloadAt: T0 } }, T0 + INTERVAL);
      expect(s.send(NOTHING_BLOCKING, T0 + INTERVAL)).toEqual(CHECK_REACHABILITY);
      return s;
    }

    it("does not reload if the window regained focus meanwhile", () => {
      const s = checkingReachability();
      expect(s.send({ type: "focus-changed", focused: true }, T0 + INTERVAL + SECOND)).toEqual([
        { type: "set-badge", badge: "idle", reason: "focused" },
      ]);
      expect(s.send(REACHABLE, T0 + INTERVAL + 2 * SECOND)).toEqual([]);
    });

    it("does not reload if the tab was paused meanwhile", () => {
      const s = checkingReachability();
      s.send({ type: "pause-toggled", paused: true }, T0 + INTERVAL + SECOND);
      expect(s.send(REACHABLE, T0 + INTERVAL + 2 * SECOND)).toEqual([]);
    });

    it("skips the tick if something started blocking meanwhile", () => {
      const s = checkingReachability();
      expect(
        s.send({ type: "reachability-checked", reachable: true, reasons: ["unsaved-input"] }, T0 + INTERVAL + SECOND),
      ).toEqual([
        { type: "schedule-timer", delayMs: INTERVAL },
        { type: "set-badge", badge: "blocked", reason: "blocked", blockers: ["unsaved-input"] },
      ]);
    });

    it("checks afresh on the next blur after an aborted check", () => {
      const s = checkingReachability();
      s.send({ type: "focus-changed", focused: true }, T0 + INTERVAL + SECOND);
      s.send(REACHABLE, T0 + INTERVAL + 2 * SECOND);
      expect(s.send({ type: "focus-changed", focused: false }, T0 + INTERVAL + 3 * SECOND)).toEqual([
        { type: "check-blockers" },
      ]);
    });
  });

  describe("when the window regains focus", () => {
    it("cancels the pending timer and goes idle", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: false, restored: null }, T0);
      expect(s.send({ type: "focus-changed", focused: true }, T0 + 10 * SECOND)).toEqual([
        { type: "cancel-timer" },
        { type: "set-badge", badge: "idle", reason: "focused" },
      ]);
    });

    it("does not reload however long it stays focused", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: true, restored: null }, T0);
      expect(s.send({ type: "timer-fired" }, T0 + 10 * 60 * SECOND)).toEqual([]);
      expect(s.send({ type: "focus-changed", focused: true }, T0 + 20 * 60 * SECOND)).toEqual([]);
    });
  });

  describe("when the interval setting changes", () => {
    it("reschedules the pending timer from the last reload with the new interval", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: false, restored: null }, T0);
      expect(s.send({ type: "settings-changed", settings: { intervalMs: 60 * SECOND } }, T0 + 10 * SECOND)).toEqual([
        { type: "schedule-timer", delayMs: 50 * SECOND },
      ]);
    });

    it("reloads at once if the shorter interval has already passed", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: false, restored: null }, T0);
      expect(s.send({ type: "settings-changed", settings: { intervalMs: 10 * SECOND } }, T0 + 15 * SECOND)).toEqual([
        { type: "cancel-timer" },
        { type: "check-blockers" },
      ]);
      expect(s.send(NOTHING_BLOCKING, T0 + 15 * SECOND)).toEqual(CHECK_REACHABILITY);
      expect(s.send(REACHABLE, T0 + 15 * SECOND)).toEqual(reloadAt(T0 + 15 * SECOND));
    });

    it("uses the new interval on the next blur when changed while focused", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: true, restored: null }, T0);
      expect(s.send({ type: "settings-changed", settings: { intervalMs: 60 * SECOND } }, T0 + 5 * SECOND)).toEqual([]);
      expect(s.send({ type: "focus-changed", focused: false }, T0 + 40 * SECOND)).toEqual([
        { type: "schedule-timer", delayMs: 20 * SECOND },
        { type: "set-badge", badge: "polling", reason: "polling" },
      ]);
    });
  });

  describe('in "Current tab" mode', () => {
    it("does not reload a hidden tab, however long it waits", () => {
      const s = scheduler();
      expect(s.send({ type: "page-loaded", focused: false, visible: false, active: true, restored: null }, T0)).toEqual([
        { type: "set-badge", badge: "idle", reason: "not-current-tab" },
      ]);
      expect(s.send({ type: "timer-fired" }, T0 + 10 * 60 * SECOND)).toEqual([]);
    });
  
    it("does not reload a tab that is not the active tab of its window", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: false, restored: null }, T0);
      expect(s.send({ type: "tab-activity-changed", active: false }, T0 + 5 * SECOND)).toEqual([
        { type: "cancel-timer" },
        { type: "set-badge", badge: "idle", reason: "not-current-tab" },
      ]);
      expect(s.send({ type: "timer-fired" }, T0 + 10 * 60 * SECOND)).toEqual([]);
    });

    it("stops polling when the tab becomes hidden mid-cycle", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: false, restored: null }, T0);
      expect(s.send({ type: "visibility-changed", visible: false }, T0 + 5 * SECOND)).toEqual([
        { type: "cancel-timer" },
        { type: "set-badge", badge: "idle", reason: "not-current-tab" },
      ]);
    });

    it("reloads right away when a hidden tab becomes visible after the interval has passed", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: false, visible: false, active: true, restored: null }, T0);
      expect(s.send({ type: "visibility-changed", visible: true }, T0 + 2 * 60 * SECOND)).toEqual([{ type: "check-blockers" }]);
      expect(s.send(NOTHING_BLOCKING, T0 + 2 * 60 * SECOND)).toEqual(CHECK_REACHABILITY);
      expect(s.send(REACHABLE, T0 + 2 * 60 * SECOND)).toEqual([
        { type: "persist", state: { lastReloadAt: T0 + 2 * 60 * SECOND } },
        { type: "reload" },
      ]);
    });

    it("waits out the rest of the interval when a hidden tab becomes visible soon after its last reload", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: false, visible: false, active: true, restored: null }, T0);
      expect(s.send({ type: "visibility-changed", visible: true }, T0 + 20 * SECOND)).toEqual([
        { type: "schedule-timer", delayMs: 10 * SECOND },
        { type: "set-badge", badge: "polling", reason: "polling" },
      ]);
    });

    it("reloads right away when a background tab becomes active and visible after the interval has passed", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: false, visible: false, active: false, restored: null }, T0);
      expect(s.send({ type: "tab-activity-changed", active: true }, T0 + 2 * 60 * SECOND)).toEqual([]);
      expect(s.send({ type: "visibility-changed", visible: true }, T0 + 2 * 60 * SECOND)).toEqual([{ type: "check-blockers" }]);
      expect(s.send(NOTHING_BLOCKING, T0 + 2 * 60 * SECOND)).toEqual(CHECK_REACHABILITY);
      expect(s.send(REACHABLE, T0 + 2 * 60 * SECOND)).toEqual([
        { type: "persist", state: { lastReloadAt: T0 + 2 * 60 * SECOND } },
        { type: "reload" },
      ]);
    });

    it("stays idle while focused, whatever the tab's visibility", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: true, restored: null }, T0);
      expect(s.send({ type: "visibility-changed", visible: false }, T0 + 5 * SECOND)).toEqual([]);
      expect(s.send({ type: "visibility-changed", visible: true }, T0 + 10 * 60 * SECOND)).toEqual([]);
    });
  });

  describe('in "All tabs" mode', () => {
    it("keeps reloading a hidden tab every interval", () => {
      const s = scheduler(INTERVAL, "all-tabs");
      expect(s.send({ type: "page-loaded", focused: false, visible: false, active: false, restored: null }, T0)).toEqual([
        { type: "schedule-timer", delayMs: INTERVAL },
        { type: "set-badge", badge: "polling", reason: "polling" },
      ]);
      expect(s.send({ type: "timer-fired" }, T0 + INTERVAL)).toEqual([{ type: "check-blockers" }]);
      expect(s.send(NOTHING_BLOCKING, T0 + INTERVAL)).toEqual(CHECK_REACHABILITY);
      expect(s.send(REACHABLE, T0 + INTERVAL)).toEqual([
        { type: "persist", state: { lastReloadAt: T0 + INTERVAL } },
        { type: "reload" },
      ]);
    });

    it("keeps polling when the tab becomes inactive or hidden", () => {
      const s = scheduler(INTERVAL, "all-tabs");
      s.send({ type: "page-loaded", focused: false, restored: null }, T0);
      expect(s.send({ type: "tab-activity-changed", active: false }, T0 + 5 * SECOND)).toEqual([]);
      expect(s.send({ type: "visibility-changed", visible: false }, T0 + 5 * SECOND)).toEqual([]);
      expect(s.send({ type: "timer-fired" }, T0 + INTERVAL)).toEqual([{ type: "check-blockers" }]);
      expect(s.send(NOTHING_BLOCKING, T0 + INTERVAL)).toEqual(CHECK_REACHABILITY);
      expect(s.send(REACHABLE, T0 + INTERVAL)).toEqual([
        { type: "persist", state: { lastReloadAt: T0 + INTERVAL } },
        { type: "reload" },
      ]);
    });

    it("still stays idle while the window is focused", () => {
      const s = scheduler(INTERVAL, "all-tabs");
      expect(s.send({ type: "page-loaded", focused: true, visible: false, active: false, restored: null }, T0)).toEqual([
        { type: "set-badge", badge: "idle", reason: "focused" },
      ]);
    });
  });

  describe("when the mode setting changes", () => {
    it('stops polling a hidden tab when switched to "Current tab"', () => {
      const s = scheduler(INTERVAL, "all-tabs");
      s.send({ type: "page-loaded", focused: false, visible: false, active: false, restored: null }, T0);
      expect(s.send({ type: "settings-changed", settings: { mode: "current-tab" } }, T0 + 10 * SECOND)).toEqual([
        { type: "cancel-timer" },
        { type: "set-badge", badge: "idle", reason: "not-current-tab" },
      ]);
    });

    it('resumes a hidden tab when switched to "All tabs", reloading if the interval has passed', () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: false, visible: false, active: false, restored: null }, T0);
      expect(s.send({ type: "settings-changed", settings: { mode: "all-tabs" } }, T0 + 10 * SECOND)).toEqual([
        { type: "schedule-timer", delayMs: 20 * SECOND },
        { type: "set-badge", badge: "polling", reason: "polling" },
      ]);

      const late = scheduler();
      late.send({ type: "page-loaded", focused: false, visible: false, active: false, restored: null }, T0);
      expect(late.send({ type: "settings-changed", settings: { mode: "all-tabs" } }, T0 + 2 * 60 * SECOND)).toEqual([{ type: "check-blockers" }]);
      expect(late.send(NOTHING_BLOCKING, T0 + 2 * 60 * SECOND)).toEqual(CHECK_REACHABILITY);
      expect(late.send(REACHABLE, T0 + 2 * 60 * SECOND)).toEqual([
        { type: "persist", state: { lastReloadAt: T0 + 2 * 60 * SECOND } },
        { type: "reload" },
      ]);
    });
  });

  describe("when the tab is paused", () => {
    it("cancels the pending timer and goes idle", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: false, restored: null }, T0);
      expect(s.send({ type: "pause-toggled", paused: true }, T0 + 5 * SECOND)).toEqual([
        { type: "cancel-timer" },
        { type: "set-badge", badge: "idle", reason: "paused" },
      ]);
    });

    it("shows paused rather than focused while the window has focus", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: true, restored: null }, T0);
      expect(s.send({ type: "pause-toggled", paused: true }, T0 + 5 * SECOND)).toEqual([
        { type: "set-badge", badge: "idle", reason: "paused" },
      ]);
      expect(s.send({ type: "focus-changed", focused: false }, T0 + 10 * 60 * SECOND)).toEqual([]);
      expect(s.send({ type: "focus-changed", focused: true }, T0 + 11 * 60 * SECOND)).toEqual([]);
    });

    it("never reloads on blur or when a stale timer fires, however long it waits", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: true, restored: null }, T0);
      s.send({ type: "pause-toggled", paused: true }, T0 + SECOND);
      expect(s.send({ type: "focus-changed", focused: false }, T0 + 5 * 60 * SECOND)).toEqual([]);
      expect(s.send({ type: "timer-fired" }, T0 + 10 * 60 * SECOND)).toEqual([]);
      expect(s.send({ type: "settings-changed", settings: { intervalMs: 10 * SECOND } }, T0 + 11 * 60 * SECOND)).toEqual(
        [],
      );
    });

    it("stays paused when the page loads again with a pause restored", () => {
      const s = scheduler();
      expect(
        s.send({ type: "page-loaded", focused: false, restored: { lastReloadAt: T0, paused: true } }, T0 + 10 * 60 * SECOND),
      ).toEqual([{ type: "set-badge", badge: "idle", reason: "paused" }]);
    });

    it("stays paused across a page-loaded event that restores no pause flag", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: false, restored: null }, T0);
      s.send({ type: "pause-toggled", paused: true }, T0 + SECOND);
      expect(s.send({ type: "page-loaded", focused: false, restored: { lastReloadAt: T0 } }, T0 + 10 * 60 * SECOND)).toEqual([
        { type: "set-badge", badge: "idle", reason: "paused" },
      ]);
    });
  });

  describe("when the tab is unpaused", () => {
    it("resumes polling for the rest of the interval", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: false, restored: null }, T0);
      s.send({ type: "pause-toggled", paused: true }, T0 + 5 * SECOND);
      expect(s.send({ type: "pause-toggled", paused: false }, T0 + 20 * SECOND)).toEqual([
        { type: "schedule-timer", delayMs: 10 * SECOND },
        { type: "set-badge", badge: "polling", reason: "polling" },
      ]);
    });

    it("reloads at once if the interval passed while paused and the window is unfocused", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: false, restored: null }, T0);
      s.send({ type: "pause-toggled", paused: true }, T0 + 5 * SECOND);
      expect(s.send({ type: "pause-toggled", paused: false }, T0 + 5 * 60 * SECOND)).toEqual([{ type: "check-blockers" }]);
      expect(s.send(NOTHING_BLOCKING, T0 + 5 * 60 * SECOND)).toEqual(CHECK_REACHABILITY);
      expect(s.send(REACHABLE, T0 + 5 * 60 * SECOND)).toEqual([
        { type: "persist", state: { lastReloadAt: T0 + 5 * 60 * SECOND, paused: false } },
        { type: "reload" },
      ]);
    });

    it("goes back to focused idle if the window has focus", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: true, restored: null }, T0);
      s.send({ type: "pause-toggled", paused: true }, T0 + SECOND);
      expect(s.send({ type: "pause-toggled", paused: false }, T0 + 2 * SECOND)).toEqual([
        { type: "set-badge", badge: "idle", reason: "focused" },
      ]);
    });
  });
});

describe("Refresh Scheduler: session loss and failures", () => {
  const MINUTE = 60 * SECOND;

  describe("when a reload fails", () => {
    it("turns the badge red and retries after twice the interval when the reload lands on an error page", () => {
      const s = scheduler();
      // The previous page reloaded at T0; the error page comes up 1s later.
      expect(
        s.send({ type: "page-loaded", page: "error", focused: false, restored: { lastReloadAt: T0 } }, T0 + SECOND),
      ).toEqual([
        { type: "persist", state: { lastReloadAt: T0, consecutiveFailures: 1 } },
        { type: "schedule-timer", delayMs: 2 * INTERVAL - SECOND },
        { type: "set-badge", badge: "error", reason: "reload-failed" },
      ]);
    });

    it("doubles the delay with each consecutive failure, capped at 5 minutes", () => {
      // Each failed reload is attempted when its timer fires; the error page then comes up on that timestamp.
      const delays: number[] = [];
      let restored: PersistedSchedulerState = { lastReloadAt: T0 };
      let at = T0;
      for (let attempt = 0; attempt < 6; attempt++) {
        const s = scheduler();
        const commands = s.send({ type: "page-loaded", page: "error", focused: false, restored }, at);
        const timer = commands.find((c) => c.type === "schedule-timer");
        if (timer?.type !== "schedule-timer") throw new Error("expected a timer");
        delays.push(timer.delayMs);
        at += timer.delayMs;
        expect(s.send({ type: "timer-fired" }, at)).toEqual([{ type: "check-blockers" }]);
        expect(s.send(NOTHING_BLOCKING, at)).toEqual(CHECK_REACHABILITY);
        const reload = s.send(REACHABLE, at);
        const persisted = reload.find((c) => c.type === "persist");
        if (persisted?.type !== "persist") throw new Error("expected a persist");
        restored = persisted.state;
      }
      expect(delays).toEqual([60 * SECOND, 2 * MINUTE, 4 * MINUTE, 5 * MINUTE, 5 * MINUTE, 5 * MINUTE]);
    });

    it("never backs off to less than the interval when the interval is longer than the cap", () => {
      const s = scheduler(10 * MINUTE);
      expect(
        s.send({ type: "page-loaded", page: "error", focused: false, restored: { lastReloadAt: T0 } }, T0),
      ).toContainEqual({ type: "schedule-timer", delayMs: 10 * MINUTE });
    });

    it("resets the backoff and the badge on the first successful board load", () => {
      const s = scheduler();
      const failedAt = T0 + 4 * MINUTE;
      expect(
        s.send(
          { type: "page-loaded", page: "board", focused: false, restored: { lastReloadAt: failedAt, consecutiveFailures: 3 } },
          failedAt + SECOND,
        ),
      ).toEqual([
        { type: "schedule-timer", delayMs: INTERVAL - SECOND },
        { type: "set-badge", badge: "polling", reason: "polling" },
      ]);
      expect(s.send({ type: "timer-fired" }, failedAt + INTERVAL)).toEqual([{ type: "check-blockers" }]);
      expect(s.send(NOTHING_BLOCKING, failedAt + INTERVAL)).toEqual(CHECK_REACHABILITY);
      expect(s.send(REACHABLE, failedAt + INTERVAL)).toEqual(reloadAt(failedAt + INTERVAL));
    });

    it("retries after the backoff when the reload could not even start", () => {
      const s = scheduler();
      expect(s.send({ type: "page-loaded", focused: false, restored: { lastReloadAt: T0 } }, T0 + 45 * SECOND)).toEqual([
        { type: "check-blockers" },
      ]);
      expect(s.send(NOTHING_BLOCKING, T0 + 45 * SECOND)).toEqual(CHECK_REACHABILITY);
      // The backoff runs from when the check failed, so a slow timeout doesn't eat into it.
      expect(s.send(UNREACHABLE, T0 + 46 * SECOND)).toEqual([
        { type: "persist", state: { lastReloadAt: T0 + 46 * SECOND, consecutiveFailures: 1 } },
        { type: "schedule-timer", delayMs: 2 * INTERVAL },
        { type: "set-badge", badge: "error", reason: "reload-failed" },
      ]);
      expect(s.send({ type: "timer-fired" }, T0 + 46 * SECOND + 2 * INTERVAL)).toEqual([{ type: "check-blockers" }]);
      expect(s.send(NOTHING_BLOCKING, T0 + 46 * SECOND + 2 * INTERVAL)).toEqual(CHECK_REACHABILITY);
      expect(s.send(UNREACHABLE, T0 + 47 * SECOND + 2 * INTERVAL)).toContainEqual({
        type: "schedule-timer",
        delayMs: 4 * INTERVAL,
      });
    });

    it("stops retrying while focused but keeps the badge red", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", page: "error", focused: false, restored: { lastReloadAt: T0 } }, T0);
      expect(s.send({ type: "focus-changed", focused: true }, T0 + SECOND)).toEqual([{ type: "cancel-timer" }]);
      expect(s.send({ type: "timer-fired" }, T0 + 10 * MINUTE)).toEqual([]);
    });

    it("keeps the badge red when a failing tab stops being the current tab", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", page: "error", focused: false, restored: { lastReloadAt: T0 } }, T0);
      expect(s.send({ type: "visibility-changed", visible: false }, T0 + SECOND)).toEqual([{ type: "cancel-timer" }]);
    });

    it("shows a pause over the failure, and red again on resume", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", page: "error", focused: false, restored: { lastReloadAt: T0 } }, T0);
      expect(s.send({ type: "pause-toggled", paused: true }, T0 + SECOND)).toEqual([
        { type: "cancel-timer" },
        { type: "set-badge", badge: "idle", reason: "paused" },
      ]);
      expect(s.send({ type: "pause-toggled", paused: false }, T0 + 2 * SECOND)).toEqual([
        { type: "schedule-timer", delayMs: 2 * INTERVAL - 2 * SECOND },
        { type: "set-badge", badge: "error", reason: "reload-failed" },
      ]);
    });

    it("shows a red badge on an error page that loads focused", () => {
      const s = scheduler();
      expect(
        s.send({ type: "page-loaded", page: "error", focused: true, restored: { lastReloadAt: T0 } }, T0 + SECOND),
      ).toEqual([
        { type: "persist", state: { lastReloadAt: T0, consecutiveFailures: 1 } },
        { type: "set-badge", badge: "error", reason: "reload-failed" },
      ]);
    });
  });

  describe("when a reload lands on the sign-in page", () => {
    it("stops refreshing and turns the badge red", () => {
      const s = scheduler();
      expect(
        s.send({ type: "page-loaded", page: "sign-in", focused: false, restored: { lastReloadAt: T0 } }, T0 + SECOND),
      ).toEqual([{ type: "set-badge", badge: "error", reason: "signed-out" }]);
    });

    it("never reloads the sign-in page, focused or not", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", page: "sign-in", focused: false, restored: { lastReloadAt: T0 } }, T0 + SECOND);
      expect(s.send({ type: "timer-fired" }, T0 + 10 * MINUTE)).toEqual([]);
      expect(s.send({ type: "focus-changed", focused: true }, T0 + 11 * MINUTE)).toEqual([]);
      expect(s.send({ type: "focus-changed", focused: false }, T0 + 12 * MINUTE)).toEqual([]);
    });

    it("shows paused rather than signed-out on a paused tab", () => {
      const s = scheduler();
      expect(
        s.send(
          { type: "page-loaded", page: "sign-in", focused: false, restored: { lastReloadAt: T0, paused: true } },
          T0 + SECOND,
        ),
      ).toEqual([{ type: "set-badge", badge: "idle", reason: "paused" }]);
    });

    it("shows signed-out again when a signed-out tab is unpaused", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", page: "sign-in", focused: false, restored: { lastReloadAt: T0, paused: true } }, T0 + SECOND);
      expect(s.send({ type: "pause-toggled", paused: false }, T0 + 2 * SECOND)).toEqual([
        { type: "set-badge", badge: "error", reason: "signed-out" },
      ]);
    });

    it("starts refreshing again once a board loads after signing in", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", page: "sign-in", focused: true, restored: { lastReloadAt: T0 } }, T0 + SECOND);
      // Signing in redirects back to the board: a new page in the same tab.
      const board = scheduler();
      expect(
        board.send({ type: "page-loaded", page: "board", focused: false, restored: { lastReloadAt: T0 } }, T0 + 2 * MINUTE),
      ).toEqual([{ type: "check-blockers" }]);
      expect(board.send(NOTHING_BLOCKING, T0 + 2 * MINUTE)).toEqual(CHECK_REACHABILITY);
      expect(board.send(REACHABLE, T0 + 2 * MINUTE)).toEqual(reloadAt(T0 + 2 * MINUTE));
    });
  });
});

describe("Refresh Scheduler: blockers together with failures", () => {
  it("never asks for a blocker check on the sign-in page", () => {
    const s = scheduler();
    expect(
      s.send({ type: "page-loaded", page: "sign-in", focused: false, restored: { lastReloadAt: T0 } }, T0 + 10 * INTERVAL),
    ).toEqual([{ type: "set-badge", badge: "error", reason: "signed-out" }]);
  });

  it("checks for blockers again before retrying a reload that could not start", () => {
    const s = scheduler();
    s.send({ type: "page-loaded", focused: false, restored: { lastReloadAt: T0 } }, T0 + INTERVAL);
    s.send(NOTHING_BLOCKING, T0 + INTERVAL);
    s.send(UNREACHABLE, T0 + INTERVAL + SECOND);
    expect(s.send({ type: "timer-fired" }, T0 + 3 * INTERVAL + SECOND)).toEqual([{ type: "check-blockers" }]);
  });

  it("turns the badge yellow when a retry is blocked, and tries again one interval later", () => {
    const s = scheduler();
    s.send({ type: "page-loaded", page: "error", focused: false, restored: { lastReloadAt: T0 } }, T0);
    expect(s.send({ type: "timer-fired" }, T0 + 2 * INTERVAL)).toEqual([{ type: "check-blockers" }]);
    expect(s.send({ type: "blockers-checked", reasons: ["unsaved-input"] }, T0 + 2 * INTERVAL)).toEqual([
      { type: "schedule-timer", delayMs: INTERVAL },
      { type: "set-badge", badge: "blocked", reason: "blocked", blockers: ["unsaved-input"] },
    ]);
  });
});

describe("normalizeTabMode", () => {
  it.each([
    ["all-tabs", "all-tabs"],
    ["current-tab", "current-tab"],
    [undefined, "current-tab"],
    ["something-else", "current-tab"],
  ])("reads %j as %j", (value, mode) => {
    expect(normalizeTabMode(value)).toBe(mode);
  });
});

describe("normalizeDetection", () => {
  it.each([
    ["smart", "smart"],
    ["always-reload", "always-reload"],
    [undefined, "smart"],
    ["something-else", "smart"],
  ])("reads %j as %j", (value, detection) => {
    expect(normalizeDetection(value)).toBe(detection);
  });
});

// Smart detection (#11) ---------------------------------------------------------

/** Fingerprints are opaque to the scheduler: it only stores them and hands them back. */
const BOARD_AT_LOAD = { lists: [], cards: { "gid://gitlab/Issue/1": "a" } } satisfies BoardFingerprint;
const BOARD_LATER = { lists: [], cards: { "gid://gitlab/Issue/1": "b" } } satisfies BoardFingerprint;

function checked(detection: ChangeDetection): SchedulerEvent {
  return { type: "changes-checked", reachable: true, detection };
}

const UNCHANGED_AT_LOAD = checked({ kind: "unchanged", fingerprint: BOARD_AT_LOAD });
const UNCHANGED_LATER = checked({ kind: "unchanged", fingerprint: BOARD_LATER });
const CHANGED = checked({ kind: "remote", changedCount: 2, fingerprint: BOARD_LATER });
const INVALID = checked({ kind: "invalid", problem: "GraphQL errors" });
const SIGNED_OUT = checked({ kind: "signed-out" });
const CHECK_FAILED: SchedulerEvent = { type: "changes-checked", reachable: false };

function smartScheduler() {
  return scheduler(INTERVAL, "current-tab", "smart");
}

/** A smart tab whose board loaded unfocused at T0 and took BOARD_AT_LOAD as its baseline. */
function smartBoardLoadedAt(at = T0) {
  const s = smartScheduler();
  s.send({ type: "page-loaded", focused: false, restored: { lastReloadAt: at } }, at);
  s.send(UNCHANGED_AT_LOAD, at);
  return s;
}

describe("Refresh Scheduler: smart detection", () => {
  describe("when a board loads", () => {
    it("takes a fresh baseline straight away", () => {
      const s = smartScheduler();
      expect(s.send({ type: "page-loaded", focused: false, restored: { lastReloadAt: T0 } }, T0)).toEqual([
        { type: "schedule-timer", delayMs: INTERVAL },
        { type: "set-badge", badge: "polling", reason: "polling" },
        { type: "check-changes", baseline: null },
      ]);
      expect(s.send(UNCHANGED_AT_LOAD, T0)).toEqual([]);
    });

    it("takes the baseline even while the window is focused", () => {
      const s = smartScheduler();
      expect(s.send({ type: "page-loaded", focused: true, restored: null }, T0)).toEqual([
        { type: "schedule-timer", delayMs: INTERVAL },
        { type: "set-badge", badge: "idle", reason: "focused" },
        { type: "check-changes", baseline: null },
      ]);
    });

    it("drops the baseline restored from the previous page: a full load resets it", () => {
      const s = smartScheduler();
      const restored = { lastReloadAt: T0, baseline: BOARD_AT_LOAD };
      expect(s.send({ type: "page-loaded", focused: false, restored }, T0 + SECOND)).toContainEqual({
        type: "check-changes",
        baseline: null,
      });
    });

    it("takes the baseline with the due check when the page loads already due", () => {
      const s = smartScheduler();
      expect(s.send({ type: "page-loaded", focused: false, restored: { lastReloadAt: T0 } }, T0 + 45 * SECOND)).toEqual([
        { type: "check-changes", baseline: null },
      ]);
      expect(s.send(UNCHANGED_AT_LOAD, T0 + 45 * SECOND)).toEqual([
        { type: "schedule-timer", delayMs: INTERVAL },
        { type: "set-badge", badge: "polling", reason: "polling" },
      ]);
    });
  });

  describe("while the window is unfocused", () => {
    it("checks for changes, not reloads, when the interval is up", () => {
      const s = smartBoardLoadedAt(T0);
      expect(s.send({ type: "timer-fired" }, T0 + INTERVAL)).toEqual([{ type: "check-changes", baseline: BOARD_AT_LOAD }]);
    });

    it("doesn't reload when nothing changed, stays green and checks again an interval later", () => {
      const s = smartBoardLoadedAt(T0);
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      expect(s.send(UNCHANGED_AT_LOAD, T0 + INTERVAL + SECOND)).toEqual([{ type: "schedule-timer", delayMs: INTERVAL }]);
      expect(s.send({ type: "timer-fired" }, T0 + 2 * INTERVAL + SECOND)).toEqual([
        { type: "check-changes", baseline: BOARD_AT_LOAD },
      ]);
    });

    it("compares the next check with the latest unchanged fingerprint", () => {
      const s = smartBoardLoadedAt(T0);
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      // For example, GitLab renumbered positions: the same board, a newer fingerprint.
      s.send(UNCHANGED_LATER, T0 + INTERVAL);
      expect(s.send({ type: "timer-fired" }, T0 + 2 * INTERVAL)).toEqual([{ type: "check-changes", baseline: BOARD_LATER }]);
    });

    it("doesn't reload for my own edit, stays green, and takes it as the new baseline", () => {
      const s = smartBoardLoadedAt(T0);
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      expect(s.send(checked({ kind: "own-edit", fingerprint: BOARD_LATER }), T0 + INTERVAL + SECOND)).toEqual([
        { type: "schedule-timer", delayMs: INTERVAL },
      ]);
      expect(s.send({ type: "timer-fired" }, T0 + 2 * INTERVAL + SECOND)).toEqual([
        { type: "check-changes", baseline: BOARD_LATER },
      ]);
    });

    it("applies a change with apply-changes, through the blocker and reachability checks", () => {
      const s = smartBoardLoadedAt(T0);
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      expect(s.send(CHANGED, T0 + INTERVAL)).toEqual([{ type: "check-blockers" }]);
      expect(s.send(NOTHING_BLOCKING, T0 + INTERVAL)).toEqual(CHECK_REACHABILITY);
      expect(s.send(REACHABLE, T0 + INTERVAL)).toEqual([{ type: "apply-changes" }]);
    });

    it("takes the fetched fingerprint as the baseline after a successful in-place apply, without reloading", () => {
      const s = smartBoardLoadedAt(T0);
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      s.send(CHANGED, T0 + INTERVAL);
      s.send(NOTHING_BLOCKING, T0 + INTERVAL);
      s.send(REACHABLE, T0 + INTERVAL);
      expect(s.send({ type: "changes-applied", applied: true }, T0 + INTERVAL + SECOND)).toEqual([
        { type: "schedule-timer", delayMs: INTERVAL },
      ]);
      expect(s.send({ type: "timer-fired" }, T0 + 2 * INTERVAL + SECOND)).toEqual([
        { type: "check-changes", baseline: BOARD_LATER },
      ]);
    });

    it("prefers the fingerprint the adapter fetched after applying", () => {
      const s = smartBoardLoadedAt(T0);
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      s.send(CHANGED, T0 + INTERVAL);
      s.send(NOTHING_BLOCKING, T0 + INTERVAL);
      s.send(REACHABLE, T0 + INTERVAL);
      s.send({ type: "changes-applied", applied: true, fingerprint: BOARD_AT_LOAD }, T0 + INTERVAL);
      expect(s.send({ type: "timer-fired" }, T0 + 2 * INTERVAL)).toEqual([
        { type: "check-changes", baseline: BOARD_AT_LOAD },
      ]);
    });

    it("reloads when the in-place apply failed", () => {
      const s = smartBoardLoadedAt(T0);
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      s.send(CHANGED, T0 + INTERVAL);
      s.send(NOTHING_BLOCKING, T0 + INTERVAL);
      s.send(REACHABLE, T0 + INTERVAL);
      expect(s.send({ type: "changes-applied", applied: false }, T0 + INTERVAL + SECOND)).toEqual([
        { type: "persist", state: { lastReloadAt: T0 + INTERVAL + SECOND, baseline: BOARD_AT_LOAD } },
        { type: "reload" },
      ]);
    });

    it("ignores an apply answer nobody is waiting for", () => {
      const s = smartBoardLoadedAt(T0);
      expect(s.send({ type: "changes-applied", applied: false }, T0 + SECOND)).toEqual([]);
    });

    it("checks again against the same baseline after a change was blocked", () => {
      const s = smartBoardLoadedAt(T0);
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      s.send(CHANGED, T0 + INTERVAL);
      expect(s.send({ type: "blockers-checked", reasons: ["sidebar-open"] }, T0 + INTERVAL)).toEqual([
        { type: "schedule-timer", delayMs: INTERVAL },
        { type: "set-badge", badge: "blocked", reason: "blocked", blockers: ["sidebar-open"] },
      ]);
      expect(s.send({ type: "timer-fired" }, T0 + 2 * INTERVAL)).toEqual([{ type: "check-changes", baseline: BOARD_AT_LOAD }]);
    });

    it("reloads like v1 when the response isn't what detection expects", () => {
      const s = smartBoardLoadedAt(T0);
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      expect(s.send(INVALID, T0 + INTERVAL)).toEqual([{ type: "check-blockers" }]);
      expect(s.send(NOTHING_BLOCKING, T0 + INTERVAL)).toEqual(CHECK_REACHABILITY);
      expect(s.send(REACHABLE, T0 + INTERVAL)).toContainEqual({ type: "reload" });
    });

    it("goes on to the reachability check when the check request fails, and backs off if the server is down", () => {
      const s = smartBoardLoadedAt(T0);
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      expect(s.send(CHECK_FAILED, T0 + INTERVAL)).toEqual([{ type: "check-blockers" }]);
      expect(s.send(NOTHING_BLOCKING, T0 + INTERVAL)).toEqual(CHECK_REACHABILITY);
      expect(s.send(UNREACHABLE, T0 + INTERVAL)).toEqual([
        { type: "persist", state: { lastReloadAt: T0 + INTERVAL, consecutiveFailures: 1, baseline: BOARD_AT_LOAD } },
        { type: "schedule-timer", delayMs: 2 * INTERVAL },
        { type: "set-badge", badge: "error", reason: "reload-failed" },
      ]);
    });

    it("clears the failures once a check gets through again", () => {
      const s = smartBoardLoadedAt(T0);
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      s.send(CHECK_FAILED, T0 + INTERVAL);
      s.send(NOTHING_BLOCKING, T0 + INTERVAL);
      s.send(UNREACHABLE, T0 + INTERVAL);
      expect(s.send({ type: "timer-fired" }, T0 + 3 * INTERVAL)).toEqual([{ type: "check-changes", baseline: BOARD_AT_LOAD }]);
      expect(s.send(UNCHANGED_AT_LOAD, T0 + 3 * INTERVAL)).toEqual([
        { type: "persist", state: { lastReloadAt: T0 + INTERVAL, baseline: BOARD_AT_LOAD } },
        { type: "schedule-timer", delayMs: INTERVAL },
        { type: "set-badge", badge: "polling", reason: "polling" },
      ]);
    });

    it("doesn't reload on a check answer that arrives after the window got focus", () => {
      const s = smartBoardLoadedAt(T0);
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      s.send({ type: "focus-changed", focused: true }, T0 + INTERVAL);
      expect(s.send(CHANGED, T0 + INTERVAL + SECOND)).not.toContainEqual({ type: "check-blockers" });
    });
  });

  describe("while the window is focused", () => {
    /** A smart tab that loaded focused at T0 and took its baseline. */
    function focusedSmart() {
      const s = smartScheduler();
      s.send({ type: "page-loaded", focused: true, restored: { lastReloadAt: T0 } }, T0);
      s.send(UNCHANGED_AT_LOAD, T0);
      return s;
    }
    const UPDATES = { type: "set-badge", badge: "updates", reason: "updates-available", changedCount: 2 };

    it("keeps checking every interval, without reloading", () => {
      const s = focusedSmart();
      expect(s.send({ type: "timer-fired" }, T0 + INTERVAL)).toEqual([{ type: "check-changes", baseline: BOARD_AT_LOAD }]);
    });

    it("stays idle and never reloads when nothing changed", () => {
      const s = focusedSmart();
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      expect(s.send(UNCHANGED_AT_LOAD, T0 + INTERVAL)).toEqual([{ type: "schedule-timer", delayMs: INTERVAL }]);
    });

    it("shows the blue updates badge with the count on a remote change, and doesn't reload", () => {
      const s = focusedSmart();
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      expect(s.send(CHANGED, T0 + INTERVAL)).toEqual([
        { type: "persist", state: { lastReloadAt: T0, baseline: BOARD_AT_LOAD, pending: { changedCount: 2, fingerprint: BOARD_LATER } } },
        { type: "schedule-timer", delayMs: INTERVAL },
        UPDATES,
      ]);
    });

    it("keeps checking against the old baseline while changes wait", () => {
      const s = focusedSmart();
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      s.send(CHANGED, T0 + INTERVAL);
      expect(s.send({ type: "timer-fired" }, T0 + 2 * INTERVAL)).toEqual([{ type: "check-changes", baseline: BOARD_AT_LOAD }]);
    });

    it("clears the badge when the board is back to how it was", () => {
      const s = focusedSmart();
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      s.send(CHANGED, T0 + INTERVAL);
      s.send({ type: "timer-fired" }, T0 + 2 * INTERVAL);
      expect(s.send(UNCHANGED_AT_LOAD, T0 + 2 * INTERVAL)).toContainEqual({ type: "set-badge", badge: "idle", reason: "focused" });
    });

    it("applies the waiting changes as soon as the window is blurred, through the blocker checks", () => {
      const s = focusedSmart();
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      s.send(CHANGED, T0 + INTERVAL);
      expect(s.send({ type: "focus-changed", focused: false }, T0 + INTERVAL + SECOND)).toEqual([
        { type: "cancel-timer" },
        { type: "check-blockers" },
      ]);
      expect(s.send(NOTHING_BLOCKING, T0 + INTERVAL + SECOND)).toEqual(CHECK_REACHABILITY);
      expect(s.send(REACHABLE, T0 + INTERVAL + SECOND)).toEqual([{ type: "apply-changes" }]);
    });

    it("retries a blocked apply on the next tick", () => {
      const s = focusedSmart();
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      s.send(CHANGED, T0 + INTERVAL);
      s.send({ type: "focus-changed", focused: false }, T0 + INTERVAL + SECOND);
      expect(s.send({ type: "blockers-checked", reasons: ["sidebar-open"] }, T0 + INTERVAL + SECOND)).toEqual([
        { type: "schedule-timer", delayMs: INTERVAL },
        { type: "set-badge", badge: "blocked", reason: "blocked", blockers: ["sidebar-open"] },
      ]);
      expect(s.send({ type: "timer-fired" }, T0 + 2 * INTERVAL + SECOND)).toEqual([{ type: "check-blockers" }]);
    });

    it("shows the updates badge again when the window is refocused after a blocked apply", () => {
      const s = focusedSmart();
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      s.send(CHANGED, T0 + INTERVAL);
      s.send({ type: "focus-changed", focused: false }, T0 + INTERVAL + SECOND);
      s.send({ type: "blockers-checked", reasons: ["sidebar-open"] }, T0 + INTERVAL + SECOND);
      expect(s.send({ type: "focus-changed", focused: true }, T0 + INTERVAL + 2 * SECOND)).toContainEqual(UPDATES);
    });

    it("never reloads a focused tab whose blocker check was still outstanding when it got focus", () => {
      const s = smartBoardLoadedAt(T0);
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      s.send(CHANGED, T0 + INTERVAL);
      s.send({ type: "focus-changed", focused: true }, T0 + INTERVAL);
      expect(s.send(NOTHING_BLOCKING, T0 + INTERVAL)).not.toContainEqual({ type: "check-reachability" });
    });

    it("doesn't reload a focused board whose check came back unreadable", () => {
      const s = focusedSmart();
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      expect(s.send(INVALID, T0 + INTERVAL)).not.toContainEqual({ type: "check-blockers" });
    });

    it("keeps pause above pending changes", () => {
      const s = focusedSmart();
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      s.send(CHANGED, T0 + INTERVAL);
      expect(s.send({ type: "pause-toggled", paused: true }, T0 + INTERVAL)).toContainEqual({
        type: "set-badge",
        badge: "idle",
        reason: "paused",
      });
    });

    it("doesn't apply pending changes on a tab that isn't the current tab", () => {
      const s = focusedSmart();
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      s.send(CHANGED, T0 + INTERVAL);
      s.send({ type: "visibility-changed", visible: false }, T0 + INTERVAL);
      expect(s.send({ type: "focus-changed", focused: false }, T0 + INTERVAL + SECOND)).not.toContainEqual({
        type: "check-blockers",
      });
    });

    it("stays focused-idle with no checks in Always reload", () => {
      const s = scheduler(INTERVAL, "current-tab", "always-reload");
      s.send({ type: "page-loaded", focused: true, restored: { lastReloadAt: T0 } }, T0);
      expect(s.send({ type: "timer-fired" }, T0 + 5 * INTERVAL)).toEqual([]);
    });
  });

  it("reloads like v1 on an error page, so it doesn't stay on it", () => {
    const s = smartScheduler();
    s.send({ type: "page-loaded", page: "error", focused: false, restored: { lastReloadAt: T0 } }, T0);
    expect(s.send({ type: "timer-fired" }, T0 + 2 * INTERVAL)).toEqual([{ type: "check-blockers" }]);
  });

  describe("when detection is unavailable", () => {
    /** A smart tab whose due check at T0 + INTERVAL found an invalid response and reloaded. */
    function degradedAfterReload() {
      const s = smartBoardLoadedAt(T0);
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      s.send(INVALID, T0 + INTERVAL);
      s.send(NOTHING_BLOCKING, T0 + INTERVAL);
      return { s, commands: s.send(REACHABLE, T0 + INTERVAL) };
    }

    it("remembers it across the reload", () => {
      expect(degradedAfterReload().commands).toEqual([
        { type: "persist", state: { lastReloadAt: T0 + INTERVAL, baseline: BOARD_AT_LOAD, degraded: true } },
        { type: "reload" },
      ]);
    });

    it("keeps checking, and reloads blindly while checks stay invalid", () => {
      const s = smartScheduler();
      const restored = { lastReloadAt: T0, degraded: true };
      s.send({ type: "page-loaded", focused: false, restored }, T0);
      s.send(INVALID, T0);
      expect(s.send({ type: "timer-fired" }, T0 + INTERVAL)).toEqual([{ type: "check-changes", baseline: null }]);
      expect(s.send(INVALID, T0 + INTERVAL)).toEqual([{ type: "check-blockers" }]);
      expect(s.send(NOTHING_BLOCKING, T0 + INTERVAL)).toEqual(CHECK_REACHABILITY);
      expect(s.send(REACHABLE, T0 + INTERVAL)).toContainEqual({ type: "reload" });
    });

    it("shows the reason in the badge status while waiting", () => {
      const s = smartScheduler();
      const restored = { lastReloadAt: T0, degraded: true };
      expect(s.send({ type: "page-loaded", focused: false, restored }, T0)).toContainEqual({
        type: "set-badge",
        badge: "polling",
        reason: "detection-unavailable",
      });
    });

    it("returns to smart behaviour once a check is valid again", () => {
      const s = smartScheduler();
      s.send({ type: "page-loaded", focused: false, restored: { lastReloadAt: T0, degraded: true } }, T0);
      s.send(INVALID, T0);
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      // A valid answer: no blind reload, and the status is back to plain polling.
      expect(s.send(UNCHANGED_AT_LOAD, T0 + INTERVAL)).toEqual([
        { type: "schedule-timer", delayMs: INTERVAL },
        { type: "set-badge", badge: "polling", reason: "polling" },
      ]);
      expect(s.send({ type: "timer-fired" }, T0 + 2 * INTERVAL)).toEqual([{ type: "check-changes", baseline: BOARD_AT_LOAD }]);
    });

    it("recovers from a valid baseline check on the next page too", () => {
      const s = smartScheduler();
      s.send({ type: "page-loaded", focused: false, restored: { lastReloadAt: T0, degraded: true } }, T0);
      s.send(UNCHANGED_AT_LOAD, T0);
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      expect(s.send({ type: "timer-fired" }, T0 + INTERVAL)).toEqual([]);
    });

    it("doesn't affect Always reload", () => {
      const s = scheduler(INTERVAL, "current-tab", "always-reload");
      expect(
        s.send({ type: "page-loaded", focused: false, restored: { lastReloadAt: T0, degraded: true } }, T0),
      ).toEqual([
        { type: "schedule-timer", delayMs: INTERVAL },
        { type: "set-badge", badge: "polling", reason: "polling" },
      ]);
    });
  });

  describe("when the session has expired", () => {
    it("halts with the signed-out badge instead of reloading", () => {
      const s = smartBoardLoadedAt(T0);
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      expect(s.send(SIGNED_OUT, T0 + INTERVAL)).toEqual([
        { type: "set-badge", badge: "error", reason: "signed-out" },
      ]);
      expect(s.send({ type: "timer-fired" }, T0 + 10 * INTERVAL)).toEqual([]);
    });

    it("halts when the baseline check finds it", () => {
      const s = smartScheduler();
      s.send({ type: "page-loaded", focused: false, restored: { lastReloadAt: T0 } }, T0);
      expect(s.send(SIGNED_OUT, T0)).toEqual([
        { type: "cancel-timer" },
        { type: "set-badge", badge: "error", reason: "signed-out" },
      ]);
    });
  });

  describe("when the check request fails", () => {
    it("shows the red badge and doubles the wait once the server proves unreachable", () => {
      const s = smartBoardLoadedAt(T0);
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      s.send(CHECK_FAILED, T0 + INTERVAL);
      s.send(NOTHING_BLOCKING, T0 + INTERVAL);
      expect(s.send(UNREACHABLE, T0 + INTERVAL)).toContainEqual({ type: "set-badge", badge: "error", reason: "reload-failed" });
    });

    it("doesn't mark detection as unavailable", () => {
      const s = smartBoardLoadedAt(T0);
      s.send({ type: "timer-fired" }, T0 + INTERVAL);
      s.send(CHECK_FAILED, T0 + INTERVAL);
      s.send(NOTHING_BLOCKING, T0 + INTERVAL);
      const commands = s.send(REACHABLE, T0 + INTERVAL);
      expect(JSON.stringify(commands)).not.toContain("degraded");
    });
  });

  describe("when the detection setting changes", () => {
    it("takes a baseline when switched to Smart on a loaded board", () => {
      const s = scheduler(INTERVAL, "current-tab", "always-reload");
      s.send({ type: "page-loaded", focused: false, restored: { lastReloadAt: T0 } }, T0);
      expect(s.send({ type: "settings-changed", settings: { detection: "smart" } }, T0 + SECOND)).toEqual([
        { type: "check-changes", baseline: null },
      ]);
    });

    it("reloads every interval like v1 when switched to Always reload", () => {
      const s = smartBoardLoadedAt(T0);
      s.send({ type: "settings-changed", settings: { detection: "always-reload" } }, T0 + SECOND);
      expect(s.send({ type: "timer-fired" }, T0 + INTERVAL)).toEqual([{ type: "check-blockers" }]);
    });
  });
});

describe('Refresh Scheduler: "Always reload"', () => {
  it("behaves like v1: no checks, a reload every interval", () => {
    const s = scheduler(INTERVAL, "current-tab", "always-reload");
    expect(s.send({ type: "page-loaded", focused: false, restored: { lastReloadAt: T0 } }, T0 + 2 * SECOND)).toEqual([
      { type: "schedule-timer", delayMs: 28 * SECOND },
      { type: "set-badge", badge: "polling", reason: "polling" },
    ]);
    expect(s.send({ type: "timer-fired" }, T0 + INTERVAL)).toEqual([{ type: "check-blockers" }]);
    expect(s.send(NOTHING_BLOCKING, T0 + INTERVAL)).toEqual(CHECK_REACHABILITY);
    expect(s.send(REACHABLE, T0 + INTERVAL)).toEqual(reloadAt(T0 + INTERVAL));
  });
});

// Safety-net full reload (#16) --------------------------------------------------

const MINUTE = 60 * SECOND;

function safetyNetScheduler(safetyNetMinutes: number) {
  return scheduler(INTERVAL, "current-tab", "smart", safetyNetMinutes);
}

/** A smart tab with a safety net whose board loaded unfocused at `at` and took BOARD_AT_LOAD as its baseline. */
function safetyNetBoardLoadedAt(safetyNetMinutes: number, at = T0) {
  const s = safetyNetScheduler(safetyNetMinutes);
  s.send({ type: "page-loaded", focused: false, restored: { lastReloadAt: at } }, at);
  s.send(UNCHANGED_AT_LOAD, at);
  return s;
}

/** Runs unchanged smart checks every interval from `from` until just before `until`. */
function checkUnchangedUntil(s: ReturnType<typeof scheduler>, from: number, until: number) {
  for (let at = from; at < until; at += INTERVAL) {
    s.send({ type: "timer-fired" }, at);
    s.send(UNCHANGED_AT_LOAD, at);
  }
}

describe("Refresh Scheduler: safety-net full reload", () => {
  it("reloads on the first due tick once the safety net is up, whatever detection says", () => {
    const s = safetyNetBoardLoadedAt(15);
    checkUnchangedUntil(s, T0 + INTERVAL, T0 + 15 * MINUTE);
    expect(s.send({ type: "timer-fired" }, T0 + 15 * MINUTE)).toEqual([{ type: "check-blockers" }]);
    expect(s.send(NOTHING_BLOCKING, T0 + 15 * MINUTE)).toEqual(CHECK_REACHABILITY);
    expect(s.send(REACHABLE, T0 + 15 * MINUTE)).toContainEqual({ type: "reload" });
  });

  it("does not reload before the safety net is up", () => {
    const s = safetyNetBoardLoadedAt(15);
    checkUnchangedUntil(s, T0 + INTERVAL, T0 + 15 * MINUTE - INTERVAL);
    expect(s.send({ type: "timer-fired" }, T0 + 15 * MINUTE - INTERVAL)).toEqual([
      { type: "check-changes", baseline: expect.anything() },
    ]);
  });

  it("is off with 0", () => {
    const s = safetyNetBoardLoadedAt(0);
    checkUnchangedUntil(s, T0 + INTERVAL, T0 + 60 * MINUTE);
    expect(s.send({ type: "timer-fired" }, T0 + 60 * MINUTE)).toEqual([
      { type: "check-changes", baseline: expect.anything() },
    ]);
  });

  it("is still gated by the blocker check", () => {
    const s = safetyNetBoardLoadedAt(15);
    checkUnchangedUntil(s, T0 + INTERVAL, T0 + 15 * MINUTE);
    s.send({ type: "timer-fired" }, T0 + 15 * MINUTE);
    const commands = s.send({ type: "blockers-checked", reasons: ["overlay-open"] }, T0 + 15 * MINUTE);
    expect(commands).not.toContainEqual({ type: "reload" });
    expect(commands).toContainEqual(expect.objectContaining({ type: "set-badge", badge: "blocked" }));
  });

  it("restarts its clock when the page loads again", () => {
    const s = safetyNetBoardLoadedAt(15);
    const later = T0 + 14 * MINUTE;
    s.send({ type: "page-loaded", focused: false, restored: { lastReloadAt: later } }, later);
    s.send(UNCHANGED_AT_LOAD, later);
    checkUnchangedUntil(s, later + INTERVAL, T0 + 16 * MINUTE);
    expect(s.send({ type: "timer-fired" }, T0 + 16 * MINUTE)).toEqual([
      { type: "check-changes", baseline: expect.anything() },
    ]);
  });

  it("does not apply in Always reload mode, which reloads every interval anyway", () => {
    const s = scheduler(INTERVAL, "current-tab", "always-reload", 15);
    s.send({ type: "page-loaded", focused: false, restored: { lastReloadAt: T0 } }, T0);
    expect(s.send({ type: "timer-fired" }, T0 + INTERVAL)).toEqual([{ type: "check-blockers" }]);
  });
});

describe("normalizeSafetyNetMinutes", () => {
  it.each([
    [15, 15],
    [0, 0],
    [30, 30],
    [2.7, 2],
    ["20", 20],
    [-5, 15],
    [Number.NaN, 15],
    ["abc", 15],
    [undefined, 15],
    [null, 15],
  ])("%j becomes %j", (value, minutes) => {
    expect(normalizeSafetyNetMinutes(value)).toBe(minutes);
  });
});
