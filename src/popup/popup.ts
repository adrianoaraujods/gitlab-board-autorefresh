/**
 * Popup (thin, untested glue). Shows the current tab's status as reported by
 * its content script, a "Pause this tab" toggle backed by the service worker,
 * and a link to the options page. A blocked tab lists what blocks the reload.
 */
import type { BadgeState } from "../core/badge";
import type { BlockerReason } from "../core/blocker-detector";
import type { SchedulerStatus, StatusReason } from "../core/refresh-scheduler";
import { sendToBackground, sendToTab } from "../shared/messages";

const BADGE_LABELS: Record<BadgeState, string> = {
  idle: "Idle",
  polling: "Auto-refreshing",
  updates: "Updates available",
  blocked: "Blocked",
  error: "Error",
};

const REASON_TEXT: Record<StatusReason, string> = {
  paused: "Paused for this tab.",
  focused: "The window has focus, so the board won't reload.",
  polling: "The window is unfocused; the board reloads on schedule.",
  "not-current-tab": "Only the visible tab of each window refreshes (\"Current tab\" mode).",
  blocked: "You're in the middle of something on the board, so the reload waits for the next tick:",
  "signed-out": "Signed out of GitLab, so auto-refresh stopped. Sign in again to resume.",
  "updates-available": "Updates available — will refresh when you switch away",
  "reload-failed": "Reloads are failing (server unreachable or an error page); retrying with backoff up to 5 minutes.",
};

const BLOCKER_TEXT: Record<BlockerReason, string> = {
  "sidebar-open": "The issue sidebar is open.",
  "unsaved-input": "A text field has unsaved input.",
  "overlay-open": "A dialog, dropdown or form is open.",
  dragging: "A card or list is being dragged.",
};

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const dot = byId("status-dot");
const text = byId("status-text");
const reason = byId("status-reason");
const details = byId<HTMLUListElement>("status-details");
const pauseRow = byId("pause-row");
const pauseToggle = byId<HTMLInputElement>("pause-toggle");

byId<HTMLAnchorElement>("options-link").addEventListener("click", (event) => {
  event.preventDefault();
  void chrome.runtime.openOptionsPage();
  window.close();
});

/** "sidebar-open" → "Sidebar open". For values added by a newer content script than this popup knows. */
function humanize(value: string): string {
  const spaced = value.replace(/[-_]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

async function fetchStatus(tabId: number): Promise<SchedulerStatus | null | undefined> {
  try {
    const reply = await sendToTab(tabId, { type: "get-status" });
    return reply?.status ?? null;
  } catch {
    return undefined; // No content script: not a board page on a granted origin.
  }
}

function renderNotABoard(): void {
  dot.dataset.badge = "none";
  text.textContent = "Not a board";
  reason.textContent = "This tab isn't a GitLab issue board on a configured domain.";
  details.hidden = true;
  pauseRow.hidden = true;
}

function renderStatus(status: SchedulerStatus | null): void {
  if (!status) {
    dot.dataset.badge = "idle";
    text.textContent = "Starting…";
    reason.textContent = "";
    details.hidden = true;
    return;
  }
  const { badge, reason: statusReason, blockers = [], changedCount } = status;
  dot.dataset.badge = badge;
  const label = BADGE_LABELS[badge] ?? humanize(badge);
  text.textContent = changedCount === undefined ? label : `${label} (${changedCount} changed)`;
  reason.textContent = REASON_TEXT[statusReason] ?? humanize(statusReason);

  details.replaceChildren(
    ...blockers.map((blocker) => {
      const li = document.createElement("li");
      li.textContent = BLOCKER_TEXT[blocker] ?? humanize(blocker);
      return li;
    }),
  );
  details.hidden = blockers.length === 0;
}

async function refresh(tabId: number): Promise<void> {
  const status = await fetchStatus(tabId);
  if (status === undefined) {
    renderNotABoard();
    return;
  }
  renderStatus(status);
  const reply = await sendToBackground({ type: "get-tab-pause", tabId });
  pauseToggle.checked = reply?.paused === true;
  pauseRow.hidden = false;
}

async function main(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tab?.id;
  if (tabId === undefined) {
    renderNotABoard();
    return;
  }
  pauseToggle.addEventListener("change", () => {
    pauseToggle.disabled = true;
    void sendToBackground({ type: "set-tab-pause", tabId, paused: pauseToggle.checked })
      .then(() => refresh(tabId))
      .finally(() => {
        pauseToggle.disabled = false;
      });
  });
  await refresh(tabId);
}

void main();
