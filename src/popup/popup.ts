/**
 * Popup (thin, untested glue). Shows the current tab's status as reported by
 * its content script, a "Pause this tab" toggle backed by the service worker,
 * and a link to the options page. Unknown badge states and reasons (added by
 * later tickets) are shown generically.
 */
import type { SchedulerStatus } from "../core/refresh-scheduler";
import { sendToBackground, sendToTab, type PauseReply, type StatusReply } from "../shared/messages";

const BADGE_LABELS: Record<string, string> = {
  idle: "Idle",
  polling: "Auto-refreshing",
  blocked: "Blocked",
  error: "Error",
};

const REASON_TEXT: Record<string, string> = {
  paused: "Paused for this tab.",
  focused: "The window has focus, so the board won't reload.",
  polling: "The window is unfocused; the board reloads on schedule.",
  "not-current-tab": "Only the visible tab of each window refreshes (\"Current tab\" mode).",
  blocked: "You're in the middle of something on the board (sidebar, unsaved text, a dropdown or a drag); the reload waits for the next tick.",
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const dot = $("status-dot");
const text = $("status-text");
const reason = $("status-reason");
const details = $<HTMLUListElement>("status-details");
const pauseRow = $("pause-row");
const pauseToggle = $<HTMLInputElement>("pause-toggle");

$<HTMLAnchorElement>("options-link").addEventListener("click", (event) => {
  event.preventDefault();
  void chrome.runtime.openOptionsPage();
  window.close();
});

/** "sidebar-open" → "Sidebar open". */
function humanize(value: string): string {
  const spaced = value.replace(/[-_]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

async function fetchStatus(tabId: number): Promise<SchedulerStatus | null | undefined> {
  try {
    const reply = (await sendToTab(tabId, { type: "get-status" })) as StatusReply | undefined;
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
  const { badge, reason: why, ...extra } = status;
  dot.dataset.badge = badge;
  text.textContent = BADGE_LABELS[badge] ?? humanize(badge);
  reason.textContent = REASON_TEXT[why] ?? humanize(why);

  // Any further fields a status carries (e.g. a list of blocker reasons) are listed as-is.
  const items = Object.values(extra as Record<string, unknown>)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
    .map((value) => (typeof value === "string" ? humanize(value) : String(value)));
  details.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      return li;
    }),
  );
  details.hidden = items.length === 0;
}

async function refresh(tabId: number): Promise<void> {
  const status = await fetchStatus(tabId);
  if (status === undefined) {
    renderNotABoard();
    return;
  }
  renderStatus(status);
  const { paused } = (await sendToBackground({ type: "get-tab-pause", tabId })) as PauseReply;
  pauseToggle.checked = paused;
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
