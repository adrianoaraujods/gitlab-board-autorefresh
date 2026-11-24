/**
 * Content Script Adapter (thin, untested glue). Injected on every page of a
 * granted origin; does nothing unless the page is an issue board. Turns window
 * focus/blur, the scheduler timer and settings changes into Refresh Scheduler
 * events, and carries out the commands it returns.
 *
 * Registration covers the whole origin, so this script also runs on the
 * sign-in page and on error pages served at a board URL, and reports them:
 * - sign-in page in a tab that was refreshing a board → `page-loaded` sign-in;
 * - board URL whose document is not a board (HTTP error page) → `page-loaded` error.
 * A server that can't be reached at all shows Chrome's own error page, where no
 * content script runs, so each reload is preceded by a cheap HEAD request; if
 * that fails the page stays and `reload-failed` is reported instead.
 *
 * Later tickets add visibility and tab-activity events (#6), the blocker
 * check (#4) and pause (#7) here.
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
      void reloadIfReachable();
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
      void sendToBackground({ type: "set-badge", badge: command.badge, reason: command.reason });
      return;
    case "persist":
      writePersisted(command.state);
      return;
  }
}

/** How long the pre-reload reachability check may take before it counts as failed. */
const PREFLIGHT_TIMEOUT_MS = 30_000;

async function reloadIfReachable(): Promise<void> {
  try {
    const response = await fetch(location.href, {
      method: "HEAD",
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
    });
    // A redirect to the sign-in page ends on a 200; reloading then lands there and is reported from that page.
    if (response.ok) {
      location.reload();
      return;
    }
  } catch {
    // Network error or timeout: the server is unreachable.
  }
  dispatch({ type: "reload-failed" });
}

/**
 * Whether the document at a board URL failed to load as a board: an HTTP error
 * status, or a page without GitLab's board markup (for example a 502 page).
 */
function boardFailedToLoad(): boolean {
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if ((navigation?.responseStatus ?? 0) >= 400) return true;
  return document.querySelector(BOARD_DOCUMENT) === null;
}

/** Server-rendered markers of a board page (see the GitLab 19.5 board DOM notes). */
const BOARD_DOCUMENT = [
  'body[data-page$="boards:index"]',
  'body[data-page$="boards:show"]',
  ".boards-app",
  ".js-focus-mode-board",
].join(", ");

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
  const restored = readPersisted();
  state = initialSchedulerState({ intervalMs: settings.intervalSeconds * 1000 });

  if (kind === "sign-in" && restored !== null) {
    // This tab was refreshing a board and its session expired: stop, red badge.
    dispatch({ type: "page-loaded", page: "sign-in", focused: document.hasFocus(), restored });
    return;
  }
  if (!isBoardPage(kind)) {
    await sendToBackground({ type: "set-badge", badge: null });
    return;
  }

  const page = boardFailedToLoad() ? "error" : "board";
  dispatch({ type: "page-loaded", page, focused: document.hasFocus(), restored });

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
