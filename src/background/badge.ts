import type { BadgeState } from "../core/badge";
import type { StatusReason } from "../core/refresh-scheduler";

const BADGE_STYLE: Record<BadgeState, { text: string; color: string }> = {
  idle: { text: "•", color: "#8a8a8a" },
  polling: { text: "•", color: "#1f883d" },
  error: { text: "!", color: "#cf222e" },
};

const REASON_TITLE: Record<StatusReason, string> = {
  focused: "Idle: the board's window has focus",
  polling: "Auto-refreshing while unfocused",
  "signed-out": "Stopped: signed out of GitLab. Sign in again to resume.",
  "reload-failed": "Reloads are failing; retrying with backoff",
};

/** Sets (or clears, with `null`) the toolbar badge for one tab. */
export async function setTabBadge(tabId: number, badge: BadgeState | null, reason?: StatusReason): Promise<void> {
  // An empty title falls back to the extension name.
  await chrome.action.setTitle({ tabId, title: reason ? REASON_TITLE[reason] : "" });
  if (badge === null) {
    await chrome.action.setBadgeText({ tabId, text: "" });
    return;
  }
  const { text, color } = BADGE_STYLE[badge];
  await chrome.action.setBadgeBackgroundColor({ tabId, color });
  await chrome.action.setBadgeText({ tabId, text });
}
