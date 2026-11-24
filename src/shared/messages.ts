import type { BadgeState } from "../core/badge";

/** Messages sent from the content script to the background service worker. */
export type ContentToBackgroundMessage =
  | {
      type: "set-badge";
      /** `null` clears the badge (not a board page). */
      badge: BadgeState | null;
    }
  /** Asks whether the sender's tab is the active tab of its window; answered with `TabActivityResponse`. */
  | { type: "get-tab-activity" };

export interface TabActivityResponse {
  active: boolean;
}

/** Messages sent from the background service worker to a content script. */
export type BackgroundToContentMessage = {
  type: "tab-activity-changed";
  /** Whether the receiving tab is now the active tab of its window. */
  active: boolean;
};

export function sendToBackground(message: ContentToBackgroundMessage): Promise<unknown> {
  return chrome.runtime.sendMessage(message);
}
