import type { BadgeState } from "../core/badge";

/** Messages sent from the content script to the background service worker. */
export type ContentToBackgroundMessage = {
  type: "set-badge";
  /** `null` clears the badge (not a board page). */
  badge: BadgeState | null;
};

export function sendToBackground(message: ContentToBackgroundMessage): Promise<unknown> {
  return chrome.runtime.sendMessage(message);
}
