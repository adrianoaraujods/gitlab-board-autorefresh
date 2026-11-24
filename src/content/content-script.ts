/**
 * Content Script Adapter (thin, untested glue). Injected on every page of a
 * granted origin; does nothing unless the page is an issue board. Turns window
 * focus/blur, the scheduler timer and settings changes into Refresh Scheduler
 * events, and carries out the commands it returns.
 *
 * Later tickets add visibility and tab-activity events (#6), the blocker
 * check (#4), pause (#7) and sign-in/failure handling (#8) here.
 */
import { isBoardPage, matchBoardPage } from "../core/board-page-matcher";
import {
  initialSchedulerState,
  transition,
  type PersistedSchedulerState,
  type SchedulerCommand,
  type SchedulerEvent,
  type SchedulerState,
} from "../core/refresh-scheduler";
import { sendToBackground } from "../shared/messages";
import { loadSettings, onSettingsChanged } from "../shared/settings";

/** sessionStorage is per tab and survives reloads, which is exactly the lifetime we need. */
const PERSIST_KEY = "gitlab-board-autorefresh:scheduler";

let state: SchedulerState;
let timer: ReturnType<typeof setTimeout> | undefined;

function dispatch(event: SchedulerEvent): void {
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
    case "set-badge":
      void sendToBackground({ type: "set-badge", badge: command.badge });
      return;
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

async function main(): Promise<void> {
  const settings = await loadSettings();
  const kind = matchBoardPage(location.href, settings.domains);
  if (!isBoardPage(kind)) {
    await sendToBackground({ type: "set-badge", badge: null });
    return;
  }

  state = initialSchedulerState({ intervalMs: settings.intervalSeconds * 1000 });
  dispatch({ type: "page-loaded", focused: document.hasFocus(), restored: readPersisted() });

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
