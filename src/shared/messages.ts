import type { BadgeState } from "../core/badge";
import type { StatusReason } from "../core/refresh-scheduler";

/** Messages sent from the content script to the background service worker. */
export type ContentToBackgroundMessage = {
  type: "set-badge";
  /** `null` clears the badge (not a board page). */
  badge: BadgeState | null;
  /** Why the tab is in this state; shown as the toolbar tooltip. */
  reason?: StatusReason;
};

export function sendToBackground(message: ContentToBackgroundMessage): Promise<unknown> {
  return chrome.runtime.sendMessage(message);
}
