import type { BadgeState } from "../core/badge";

const BADGE_STYLE: Record<BadgeState, { text: string; color: string }> = {
  idle: { text: "•", color: "#8a8a8a" },
  polling: { text: "•", color: "#1f883d" },
  updates: { text: "•", color: "#0969da" },
  blocked: { text: "•", color: "#d4a72c" },
  error: { text: "!", color: "#cf222e" },
};

/** Sets (or clears, with `null`) the toolbar badge for one tab. */
export async function setTabBadge(tabId: number, badge: BadgeState | null, count?: number): Promise<void> {
  if (badge === null) {
    await chrome.action.setBadgeText({ tabId, text: "" });
    return;
  }
  const { color, text: dot } = BADGE_STYLE[badge];
  const text = count === undefined ? dot : String(Math.min(count, 999));
  await chrome.action.setBadgeBackgroundColor({ tabId, color });
  await chrome.action.setBadgeText({ tabId, text });
}
