import { describe, expect, it } from "vitest";
import {
  initialSchedulerState,
  transition,
  type SchedulerCommand,
  type SchedulerEvent,
  type SchedulerState,
} from "./refresh-scheduler";

const SECOND = 1000;
const INTERVAL = 30 * SECOND;
/** An arbitrary wall-clock start, so tests never depend on `now` being 0. */
const T0 = 1_700_000_000_000;

/** The adapter's answer when the Blocker Detector finds nothing in the way. */
const NOTHING_BLOCKING: SchedulerEvent = { type: "blockers-checked", reasons: [] };

/** The commands that reload the page, recording `at` as the last reload. */
function reloadAt(at: number): SchedulerCommand[] {
  return [{ type: "persist", state: { lastReloadAt: at } }, { type: "reload" }];
}

/**
 * Feeds events into the scheduler one at a time, threading state through, and
 * returns the commands each event produced. Tests only look at commands.
 */
function scheduler(intervalMs = INTERVAL) {
  let state: SchedulerState = initialSchedulerState({ intervalMs });
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
      expect(s.send(NOTHING_BLOCKING, T0 + 5 * 60 * SECOND)).toEqual(reloadAt(T0 + 5 * 60 * SECOND));
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
      expect(s.send(NOTHING_BLOCKING, T0 + 30 * SECOND)).toEqual(reloadAt(T0 + 30 * SECOND));
    });

    it("keeps reloading every interval across page reloads, timed from the last reload", () => {
      const s = scheduler();
      // A previous page of this tab reloaded at T0; the reloaded page comes up unfocused 2s later.
      expect(s.send({ type: "page-loaded", focused: false, restored: { lastReloadAt: T0 } }, T0 + 2 * SECOND)).toEqual([
        { type: "schedule-timer", delayMs: 28 * SECOND },
        { type: "set-badge", badge: "polling", reason: "polling" },
      ]);
      expect(s.send({ type: "timer-fired" }, T0 + 30 * SECOND)).toEqual([{ type: "check-blockers" }]);
      expect(s.send(NOTHING_BLOCKING, T0 + 30 * SECOND)).toEqual(reloadAt(T0 + 30 * SECOND));

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
      expect(s.send(NOTHING_BLOCKING, T0 + 45 * SECOND)).toEqual(reloadAt(T0 + 45 * SECOND));
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
        { type: "set-badge", badge: "blocked", reason: "blocked" },
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
      expect(s.send(NOTHING_BLOCKING, T0 + 3 * INTERVAL)).toEqual(reloadAt(T0 + 3 * INTERVAL));
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
      expect(s.send(NOTHING_BLOCKING, T0 + 15 * SECOND)).toEqual(reloadAt(T0 + 15 * SECOND));
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
});
