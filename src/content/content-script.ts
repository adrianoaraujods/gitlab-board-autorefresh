/**
 * Content Script Adapter (thin, untested glue). Injected on every page of a
 * granted origin; does nothing unless the page is an issue board. Turns window
 * focus/blur, page visibility, tab activity (from the background worker), the
 * scheduler timer and settings changes into Refresh Scheduler events, and
 * carries out the commands it returns.
 *
 * It also answers the popup's status query and applies pause toggles (#7);
 * the background worker owns the pause flag, which is merged into the
 * restored state on load.
 *
 * Registration covers the whole origin, so this script also runs on the
 * sign-in page and on error pages served at a board URL, and reports them (#8):
 * - sign-in page in a tab that was refreshing a board → `page-loaded` sign-in;
 * - board URL whose document is not a board (HTTP error page) → `page-loaded` error.
 * A server that can't be reached at all shows Chrome's own error page, where no
 * content script runs, so each reload is preceded by a cheap HEAD request; if
 * that fails the page stays and `reload-failed` is reported instead.
 *
 * A later ticket adds the blocker check (#4) here.
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
import { restoreScrollSnapshot, saveScrollSnapshot } from "../core/scroll-snapshot";
import {
  sendToBackground,
  type PauseReply,
  type StatusReply,
  type TabActivityResponse,
  type ToContentMessage,
} from "../shared/messages";
import { loadSettings, onSettingsChanged } from "../shared/settings";

/** sessionStorage is per tab and survives reloads, which is exactly the lifetime we need. */
const PERSIST_KEY = "gitlab-board-autorefresh:scheduler";
/** How long a restored board may take to render its lists before the scroll restore gives up. */
const SCROLL_RESTORE_TIMEOUT_MS = 10_000;

let state: SchedulerState | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
/** The last status sent to the badge, reported to the popup. */
let lastStatus: SchedulerStatus | null = null;

function dispatch(event: SchedulerEvent): void {
  if (state === undefined) return;
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
      saveScroll();
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

function saveScroll(): void {
  try {
    saveScrollSnapshot(document, sessionStorage, { url: location.href, now: Date.now() });
  } catch {
    // Storage unavailable or full: reload anyway, the board just starts at the top.
  }
}

function restoreScroll(): void {
  try {
    void restoreScrollSnapshot(document, sessionStorage, {
      url: location.href,
      now: Date.now(),
      timeoutMs: SCROLL_RESTORE_TIMEOUT_MS,
    });
  } catch {
    // Storage unavailable: nothing to restore.
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

async function isActiveTab(): Promise<boolean> {
  try {
    const response = (await sendToBackground({ type: "get-tab-activity" })) as TabActivityResponse | undefined;
    return response?.active ?? true;
  } catch {
    return true;
  }
}

async function main(): Promise<void> {
  const settings = await loadSettings();
  const kind = matchBoardPage(location.href, settings.domains);
  const restored = readPersisted();
  // The sign-in page in a tab that was refreshing a board means its session expired: report it (red badge).
  const signedOut = kind === "sign-in" && restored !== null;
  if (!isBoardPage(kind) && !signedOut) {
    await sendToBackground({ type: "set-badge", badge: null });
    return;
  }

  const page = signedOut ? "sign-in" : boardFailedToLoad() ? "error" : "board";
  if (page === "board") restoreScroll();

  // Listen before asking, so an activity or pause change during the round trips isn't lost.
  let pendingActive: boolean | undefined;
  let pendingPaused: boolean | undefined;
  chrome.runtime.onMessage.addListener((message: ToContentMessage, _sender, sendResponse) => {
    switch (message.type) {
      case "tab-activity-changed":
        if (state === undefined) pendingActive = message.active;
        else dispatch({ type: "tab-activity-changed", active: message.active });
        return;
      case "pause-toggled":
        if (state === undefined) pendingPaused = message.paused;
        else dispatch({ type: "pause-toggled", paused: message.paused });
        return;
      case "get-status":
        sendResponse({ status: lastStatus } satisfies StatusReply);
        return;
    }
  });
  const [active, paused] = await Promise.all([isActiveTab(), fetchPaused()]);

  state = initialSchedulerState({ intervalMs: settings.intervalSeconds * 1000, mode: settings.mode });
  dispatch({
    type: "page-loaded",
    page,
    focused: document.hasFocus(),
    visible: document.visibilityState === "visible",
    active: pendingActive ?? active,
    restored: { ...(restored ?? { lastReloadAt: null }), paused: pendingPaused ?? paused },
  });

  window.addEventListener("focus", () => dispatch({ type: "focus-changed", focused: true }));
  window.addEventListener("blur", () => dispatch({ type: "focus-changed", focused: false }));
  document.addEventListener("visibilitychange", () =>
    dispatch({ type: "visibility-changed", visible: document.visibilityState === "visible" }),
  );
  onSettingsChanged((keys) => {
    if (!keys.includes("intervalSeconds") && !keys.includes("mode")) return;
    void loadSettings().then(({ intervalSeconds, mode }) =>
      dispatch({ type: "settings-changed", settings: { intervalMs: intervalSeconds * 1000, mode } }),
    );
  });
}

void main();
