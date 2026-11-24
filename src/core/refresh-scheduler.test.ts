import { describe, expect, it } from "vitest";
import {
  initialSchedulerState,
  transition,
  type SchedulerCommand,
  type SchedulerEvent,
  type SchedulerState,
  type TabMode,
} from "./refresh-scheduler";

const SECOND = 1000;
const INTERVAL = 30 * SECOND;
/** An arbitrary wall-clock start, so tests never depend on `now` being 0. */
const T0 = 1_700_000_000_000;

/**
 * Feeds events into the scheduler one at a time, threading state through, and
 * returns the commands each event produced. Tests only look at commands.
 */
function scheduler(intervalMs = INTERVAL, mode: TabMode = "current-tab") {
  let state: SchedulerState = initialSchedulerState({ intervalMs, mode });
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
        { type: "persist", state: { lastReloadAt: T0 + 5 * 60 * SECOND } },
        { type: "reload" },
      ]);
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
      expect(s.send({ type: "timer-fired" }, T0 + 30 * SECOND)).toEqual([
        { type: "persist", state: { lastReloadAt: T0 + 30 * SECOND } },
        { type: "reload" },
      ]);
    });

    it("keeps reloading every interval across page reloads, timed from the last reload", () => {
      const s = scheduler();
      // A previous page of this tab reloaded at T0; the reloaded page comes up unfocused 2s later.
      expect(s.send({ type: "page-loaded", focused: false, restored: { lastReloadAt: T0 } }, T0 + 2 * SECOND)).toEqual([
        { type: "schedule-timer", delayMs: 28 * SECOND },
        { type: "set-badge", badge: "polling", reason: "polling" },
      ]);
      expect(s.send({ type: "timer-fired" }, T0 + 30 * SECOND)).toEqual([
        { type: "persist", state: { lastReloadAt: T0 + 30 * SECOND } },
        { type: "reload" },
      ]);

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
        { type: "persist", state: { lastReloadAt: T0 + 45 * SECOND } },
        { type: "reload" },
      ]);
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
      expect(s.send({ type: "focus-changed", focused: true }, T0 + 46 * SECOND)).toEqual([]);
      expect(s.send({ type: "timer-fired" }, T0 + 90 * SECOND)).toEqual([]);
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
        { type: "persist", state: { lastReloadAt: T0 + 15 * SECOND } },
        { type: "reload" },
      ]);
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
      expect(s.send({ type: "visibility-changed", visible: true }, T0 + 2 * 60 * SECOND)).toEqual([
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
      expect(s.send({ type: "visibility-changed", visible: true }, T0 + 2 * 60 * SECOND)).toEqual([
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
      expect(s.send({ type: "timer-fired" }, T0 + INTERVAL)).toEqual([
        { type: "persist", state: { lastReloadAt: T0 + INTERVAL } },
        { type: "reload" },
      ]);
    });

    it("keeps polling when the tab becomes inactive or hidden", () => {
      const s = scheduler(INTERVAL, "all-tabs");
      s.send({ type: "page-loaded", focused: false, restored: null }, T0);
      expect(s.send({ type: "tab-activity-changed", active: false }, T0 + 5 * SECOND)).toEqual([]);
      expect(s.send({ type: "visibility-changed", visible: false }, T0 + 5 * SECOND)).toEqual([]);
      expect(s.send({ type: "timer-fired" }, T0 + INTERVAL)).toEqual([
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
      expect(late.send({ type: "settings-changed", settings: { mode: "all-tabs" } }, T0 + 2 * 60 * SECOND)).toEqual([
        { type: "persist", state: { lastReloadAt: T0 + 2 * 60 * SECOND } },
        { type: "reload" },
      ]);
    });
  });
});
