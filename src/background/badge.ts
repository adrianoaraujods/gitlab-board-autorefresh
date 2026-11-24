import type { BadgeState } from "../core/badge";

const BADGE_STYLE: Record<BadgeState, { text: string; color: string }> = {
  idle: { text: "•", color: "#8a8a8a" },
  polling: { text: "•", color: "#1f883d" },
  blocked: { text: "•", color: "#d4a72c" },
};

/** Sets (or clears, with `null`) the toolbar badge for one tab. */
export async function setTabBadge(tabId: number, badge: BadgeState | null): Promise<void> {
  if (badge === null) {
    await chrome.action.setBadgeText({ tabId, text: "" });
    return;
  }
  const { text, color } = BADGE_STYLE[badge];
  await chrome.action.setBadgeBackgroundColor({ tabId, color });
  await chrome.action.setBadgeText({ tabId, text });
}
