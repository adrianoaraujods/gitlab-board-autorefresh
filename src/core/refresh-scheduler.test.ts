import { describe, expect, it } from "vitest";
import {
  initialSchedulerState,
  transition,
  type PersistedSchedulerState,
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
      expect(s.send({ type: "pause-toggled", paused: false }, T0 + 5 * 60 * SECOND)).toEqual([
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
        const reload = s.send({ type: "timer-fired" }, at);
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
      expect(s.send({ type: "timer-fired" }, failedAt + INTERVAL)).toEqual([
        { type: "persist", state: { lastReloadAt: failedAt + INTERVAL } },
        { type: "reload" },
      ]);
    });

    it("retries after the backoff when the reload could not even start", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", focused: false, restored: { lastReloadAt: T0 } }, T0 + 45 * SECOND);
      expect(s.send({ type: "reload-failed" }, T0 + 46 * SECOND)).toEqual([
        { type: "persist", state: { lastReloadAt: T0 + 45 * SECOND, consecutiveFailures: 1 } },
        { type: "schedule-timer", delayMs: 2 * INTERVAL - SECOND },
        { type: "set-badge", badge: "error", reason: "reload-failed" },
      ]);
      expect(s.send({ type: "timer-fired" }, T0 + 45 * SECOND + 2 * INTERVAL)).toEqual([
        { type: "persist", state: { lastReloadAt: T0 + 45 * SECOND + 2 * INTERVAL, consecutiveFailures: 1 } },
        { type: "reload" },
      ]);
      expect(s.send({ type: "reload-failed" }, T0 + 46 * SECOND + 2 * INTERVAL)).toContainEqual({
        type: "schedule-timer",
        delayMs: 4 * INTERVAL - SECOND,
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

    it("shows signed-out even on a paused tab", () => {
      const s = scheduler();
      expect(
        s.send(
          { type: "page-loaded", page: "sign-in", focused: false, restored: { lastReloadAt: T0, paused: true } },
          T0 + SECOND,
        ),
      ).toEqual([{ type: "set-badge", badge: "error", reason: "signed-out" }]);
    });

    it("starts refreshing again once a board loads after signing in", () => {
      const s = scheduler();
      s.send({ type: "page-loaded", page: "sign-in", focused: true, restored: { lastReloadAt: T0 } }, T0 + SECOND);
      // Signing in redirects back to the board: a new page in the same tab.
      const board = scheduler();
      expect(
        board.send({ type: "page-loaded", page: "board", focused: false, restored: { lastReloadAt: T0 } }, T0 + 2 * MINUTE),
      ).toEqual([
        { type: "persist", state: { lastReloadAt: T0 + 2 * MINUTE } },
        { type: "reload" },
      ]);
    });
  });
});
