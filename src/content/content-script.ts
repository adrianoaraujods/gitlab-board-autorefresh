/**
 * Content Script Adapter (thin, untested glue). Injected on every page of a
 * granted origin; does nothing unless the page is an issue board. Turns window
 * focus/blur, browser-window focus (asked on blur, and pushed by the background
 * worker), page visibility, tab activity (from the background worker), the
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
 * content script runs, so each reload is preceded by a cheap HEAD request
 * (`check-reachability`); if that fails the page stays and the scheduler
 * backs off.
 *
 * It runs the Blocker Detector when the scheduler asks (#4). On a due tick
 * the order is: blocker check → (if clear) HEAD reachability check plus a
 * second blocker check → (if the scheduler still wants it) save the scroll
 * snapshot → reload.
 *
 * In smart detection (#11) the scheduler asks for `check-changes` first: one
 * POST to the instance's `/api/graphql` with the session cookie and the
 * page's CSRF token, built and compared by the Change Detector. A failed
 * request is reported as such; a board URL without a board id can't be
 * fingerprinted and answers `invalid` (the scheduler then reloads like v1).
 *
 * Own edits (#15): the current user id is read from the page, and card
 * drag-end/drop events on the board are noted as "a local drag finished", both
 * handed to the Change Detector with the "Refresh after my own edits" setting.
 */
import { detectBlockers } from "../core/blocker-detector";
import { isBoardDocument, isBoardPage, matchBoardPage } from "../core/board-page-matcher";
import {
  buildFingerprintRequest,
  compare,
  readBoardContext,
  readCurrentUserId,
  type BoardFingerprint,
} from "../core/change-detector";
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
import { sendToBackground, type StatusReply, type ToContentMessage } from "../shared/messages";
import { loadSettings, onSettingsChanged, toSchedulerSettings, type Settings } from "../shared/settings";

/** sessionStorage is per tab and survives reloads, which is exactly the lifetime we need. */
const PERSIST_KEY = "gitlab-board-autorefresh:scheduler";
/** How long a restored board may take to render its lists before the scroll restore gives up. */
const SCROLL_RESTORE_TIMEOUT_MS = 10_000;

let state: SchedulerState | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
/** A card drag finished in this tab since the last check that read a response. */
let localDrag = false;
/** The "Refresh after my own edits" setting. */
let refreshAfterOwnEdits = false;
/** The settings the Refresh Scheduler reads: a change to any of them is a `settings-changed` event. */
const SCHEDULER_SETTING_KEYS: (keyof Settings)[] = ["intervalSeconds", "mode", "detection", "safetyNetMinutes"];
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
    case "check-reachability":
      void checkReachability().then((reachable) =>
        dispatch(
          reachable
            ? { type: "reachability-checked", reachable, reasons: [...detectBlockers(document)] }
            : { type: "reachability-checked", reachable },
        ),
      );
      return;
    case "check-changes":
      void checkChanges(command.baseline).then(dispatch);
      return;
    case "apply-changes":
      void applyChanges().then(dispatch);
      return;
    case "reload":
      saveScroll();
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
    case "check-blockers":
      // Answer once the current dispatch has finished running its commands.
      queueMicrotask(() => dispatch({ type: "blockers-checked", reasons: [...detectBlockers(document)] }));
      return;
    case "set-badge": {
      const { type: _type, ...status } = command;
      lastStatus = status;
      void sendToBackground({ type: "set-badge", badge: command.badge, count: command.changedCount });
      return;
    }
    case "persist":
      writePersisted(command.state);
      return;
  }
}

/**
 * Applies a detected change. With "Update in place" on, refetches the board's
 * data through the page's own Apollo client and takes a fresh fingerprint as
 * the new baseline; with it off, or when that isn't possible, answers
 * not-applied and the scheduler reloads.
 */
async function applyChanges(): Promise<SchedulerEvent> {
  try {
    if ((await loadSettings()).updateInPlace) {
      const reply = await sendToBackground({ type: "refetch-board" });
      if (reply?.ok === true) {
        const fingerprint = await freshFingerprint();
        // The board shows what the server has now, so a drag of mine is accounted for.
        localDrag = false;
        return { type: "changes-applied", applied: true, ...(fingerprint && { fingerprint }) };
      }
    }
  } catch {
    // Fall through: reload.
  }
  return { type: "changes-applied", applied: false };
}

/** The board's current fingerprint, or `undefined` if the check failed or couldn't be read. */
async function freshFingerprint(): Promise<BoardFingerprint | undefined> {
  const checked = await checkChanges(null);
  if (checked.type !== "changes-checked" || !checked.reachable) return undefined;
  const { detection } = checked;
  return detection.kind === "unchanged" || detection.kind === "remote" ? detection.fingerprint : undefined;
}

/** How long the pre-reload reachability check may take before it counts as failed. */
const PREFLIGHT_TIMEOUT_MS = 30_000;

/** Whether the server answers the board URL; a network error or timeout means it is unreachable. */
async function checkReachability(): Promise<boolean> {
  try {
    const response = await fetch(location.href, {
      method: "HEAD",
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
    });
    // A redirect to the sign-in page ends on a 200; reloading then lands there and is reported from that page.
    return response.ok;
  } catch {
    return false;
  }
}

/** How long the change-detection request may take before it counts as failed. */
const CHECK_CHANGES_TIMEOUT_MS = 30_000;

/** Fetches the board's fingerprint and compares it with `baseline` (Change Detector). */
async function checkChanges(baseline: BoardFingerprint | null): Promise<SchedulerEvent> {
  const page = readBoardContext(location.href, document);
  if (page === null) {
    return { type: "changes-checked", reachable: true, detection: { kind: "invalid", problem: "no board id in the URL" } };
  }
  const { query, variables } = buildFingerprintRequest(page.board);
  // A drag of mine is only used up once the baseline advances to a result that took it into account.
  const drag = localDrag;
  let response: Response;
  try {
    response = await fetch(page.graphqlUrl, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken(),
      },
      body: JSON.stringify({
        operationName: "BoardAutoRefreshFingerprint",
        query,
        variables,
      }),
      signal: AbortSignal.timeout(CHECK_CHANGES_TIMEOUT_MS),
    });
  } catch {
    // A network error or timeout: the server couldn't be asked.
    return { type: "changes-checked", reachable: false };
  }
  if (!response.ok) {
    // The server answered with an HTTP error: detection can't read it, but the server is up.
    return {
      type: "changes-checked",
      reachable: true,
      detection: { kind: "invalid", problem: `HTTP ${response.status}` },
    };
  }
  // A body that isn't JSON is a response detection can't read.
  const body: unknown = await response.json().catch(() => null);
  const detection = compare(baseline, body, {
    currentUserId: readCurrentUserId(document),
    localDrag: drag,
    refreshAfterOwnEdits,
  });
  if (baseline !== null && (detection.kind === "unchanged" || detection.kind === "own-edit")) localDrag = false;
  return { type: "changes-checked", reachable: true, detection };
}

/** GitLab's CSRF token from the page head, sent as `X-CSRF-Token` like GitLab's own GraphQL client. */
function csrfToken(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? "";
}

/**
 * Whether the document at a board URL failed to load as a board: an HTTP error
 * status, or a page without GitLab's board markup (for example a 502 page).
 */
function boardFailedToLoad(): boolean {
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if ((navigation?.responseStatus ?? 0) >= 400) return true;
  return !isBoardDocument(document);
}

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
    const reply = await sendToBackground({ type: "get-pause" });
    return reply?.paused === true;
  } catch {
    return false;
  }
}

async function isActiveTab(): Promise<boolean> {
  try {
    const response = await sendToBackground({ type: "get-tab-activity" });
    return response?.active ?? true;
  } catch {
    return true;
  }
}

async function isWindowFocused(): Promise<boolean> {
  try {
    const reply = await sendToBackground({ type: "get-window-focus" });
    return reply?.focused === true;
  } catch {
    return false;
  }
}

/** On a DOM blur, asks whether the browser window still has focus (toolbar popup, omnibox). */
async function onBlur(): Promise<void> {
  dispatch({ type: "focus-changed", focused: false });
  dispatch({ type: "window-focus-changed", focused: await isWindowFocused() });
}

async function main(): Promise<void> {
  const settings = await loadSettings();
  refreshAfterOwnEdits = settings.refreshAfterOwnEdits;
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
  let pendingWindowFocused: boolean | undefined;
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
      case "window-focus-changed":
        if (state === undefined) pendingWindowFocused = message.focused;
        else dispatch({ type: "window-focus-changed", focused: message.focused });
        return;
      case "get-status":
        sendResponse({ status: lastStatus } satisfies StatusReply);
        return;
    }
  });
  const [active, paused, windowFocused] = await Promise.all([isActiveTab(), fetchPaused(), isWindowFocused()]);

  state = initialSchedulerState(toSchedulerSettings(settings));
  dispatch({
    type: "page-loaded",
    page,
    focused: document.hasFocus(),
    windowFocused: pendingWindowFocused ?? windowFocused,
    visible: document.visibilityState === "visible",
    active: pendingActive ?? active,
    restored: { ...(restored ?? { lastReloadAt: null }), paused: pendingPaused ?? paused },
  });

  // A finished card drag (SortableJS fires these on the dragged card) is the user's own reorder.
  for (const type of ["dragend", "drop"]) {
    document.addEventListener(
      type,
      (event) => {
        if (event.target instanceof Element && event.target.closest(".board-card, .board-list, .boards-list"))
          localDrag = true;
      },
      true,
    );
  }
  window.addEventListener("focus", () => dispatch({ type: "focus-changed", focused: true }));
  window.addEventListener("blur", () => void onBlur());
  document.addEventListener("visibilitychange", () =>
    dispatch({ type: "visibility-changed", visible: document.visibilityState === "visible" }),
  );
  onSettingsChanged((keys) => {
    if (keys.includes("refreshAfterOwnEdits"))
      void loadSettings().then((changed) => (refreshAfterOwnEdits = changed.refreshAfterOwnEdits));
    if (!SCHEDULER_SETTING_KEYS.some((key) => keys.includes(key))) return;
    void loadSettings().then((changed) => dispatch({ type: "settings-changed", settings: toSchedulerSettings(changed) }));
  });
}

void main();
