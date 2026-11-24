/**
 * Content Script Adapter (thin, untested glue). Injected on every page of a
 * granted origin; does nothing unless the page is an issue board. Turns window
 * focus/blur, the scheduler timer and settings changes into Refresh Scheduler
 * events, and carries out the commands it returns.
 *
 * It also answers the popup's status query and applies pause toggles (#7);
 * the background worker owns the pause flag, which is merged into the
 * restored state on load. Later tickets add visibility and tab-activity
 * events (#6), the blocker check (#4) and sign-in/failure handling (#8) here.
 */
import { isBoardPage, matchBoardPage } from "../core/board-page-matcher";
import {
  initialSchedulerState,
  transition,
  type PersistedSchedulerState,
  type SchedulerCommand,
  type SchedulerEvent,
  type SchedulerState,
  type SchedulerStatus,
} from "../core/refresh-scheduler";
import { sendToBackground, type PauseReply, type StatusReply, type ToContentMessage } from "../shared/messages";
import { loadSettings, onSettingsChanged } from "../shared/settings";

/** sessionStorage is per tab and survives reloads, which is exactly the lifetime we need. */
const PERSIST_KEY = "gitlab-board-autorefresh:scheduler";

let state: SchedulerState | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
/** The last status sent to the badge, reported to the popup. */
let lastStatus: SchedulerStatus | null = null;
/** A pause toggle that arrived before the first page-loaded dispatch. */
let earlyPause: boolean | undefined;

function dispatch(event: SchedulerEvent): void {
  if (!state) return;
  const result = transition(state, event, Date.now());
  state = result.state;
  for (const command of result.commands) run(command);
}

function run(command: SchedulerCommand): void {
  switch (command.type) {
    case "reload":
      location.reload();
      return;
    case "schedule-timer":
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        dispatch({ type: "timer-fired" });
      }, command.delayMs);
      return;
    case "cancel-timer":
      clearTimeout(timer);
      timer = undefined;
      return;
    case "set-badge": {
      const { type: _type, ...status } = command;
      lastStatus = status;
      void sendToBackground({ type: "set-badge", badge: command.badge });
      return;
    }
    case "persist":
      writePersisted(command.state);
      return;
  }
}

function readPersisted(): PersistedSchedulerState | null {
  try {
    const raw = sessionStorage.getItem(PERSIST_KEY);
    return raw === null ? null : (JSON.parse(raw) as PersistedSchedulerState);
  } catch {
    return null;
  }
}

function writePersisted(persisted: PersistedSchedulerState): void {
  try {
    sessionStorage.setItem(PERSIST_KEY, JSON.stringify(persisted));
  } catch {
    // Storage unavailable: the next page load starts a fresh cycle.
  }
}

async function fetchPaused(): Promise<boolean> {
  try {
    const reply = (await sendToBackground({ type: "get-pause" })) as PauseReply | undefined;
    return reply?.paused === true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const settings = await loadSettings();
  const kind = matchBoardPage(location.href, settings.domains);
  if (!isBoardPage(kind)) {
    await sendToBackground({ type: "set-badge", badge: null });
    return;
  }

  chrome.runtime.onMessage.addListener((message: ToContentMessage, _sender, sendResponse) => {
    if (message.type === "pause-toggled") {
      if (state) dispatch({ type: "pause-toggled", paused: message.paused });
      else earlyPause = message.paused;
      return;
    }
    if (message.type === "get-status") sendResponse({ status: lastStatus } satisfies StatusReply);
  });

  const fetched = await fetchPaused();
  const paused = earlyPause ?? fetched;
  state = initialSchedulerState({ intervalMs: settings.intervalSeconds * 1000 });
  dispatch({ type: "page-loaded", focused: document.hasFocus(), restored: { ...(readPersisted() ?? { lastReloadAt: null }), paused } });

  window.addEventListener("focus", () => dispatch({ type: "focus-changed", focused: true }));
  window.addEventListener("blur", () => dispatch({ type: "focus-changed", focused: false }));
  onSettingsChanged((keys) => {
    if (!keys.includes("intervalSeconds")) return;
    void loadSettings().then(({ intervalSeconds }) =>
      dispatch({ type: "settings-changed", settings: { intervalMs: intervalSeconds * 1000 } }),
    );
  });
}

void main();
