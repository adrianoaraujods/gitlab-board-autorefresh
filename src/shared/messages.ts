import type { BadgeState } from "../core/badge";
import type { SchedulerStatus } from "../core/refresh-scheduler";

/** Messages sent from the content script to the background service worker. */
export type ContentToBackgroundMessage =
  | {
      type: "set-badge";
      /** `null` clears the badge (not a board page). */
      badge: BadgeState | null;
    }
  /** Asks whether the sender's tab is the active tab of its window; answered with `TabActivityResponse`. */
  | { type: "get-tab-activity" }
  /** Asks whether the sender's tab is paused; answered with `PauseReply`. */
  | { type: "get-pause" };

export interface TabActivityResponse {
  active: boolean;
}

/** Messages sent from the background service worker to a content script. */
export type BackgroundToContentMessage =
  | {
      type: "tab-activity-changed";
      /** Whether the receiving tab is now the active tab of its window. */
      active: boolean;
    }
  | { type: "pause-toggled"; paused: boolean };

/** Messages sent from the popup to the background service worker. */
export type PopupToBackgroundMessage =
  /** Asks whether `tabId` is paused; answered with `PauseReply`. */
  | { type: "get-tab-pause"; tabId: number }
  /** Pauses or unpauses `tabId` and tells its content script; answered with `PauseReply`. */
  | { type: "set-tab-pause"; tabId: number; paused: boolean };

export type BackgroundMessage = ContentToBackgroundMessage | PopupToBackgroundMessage;

export interface PauseReply {
  paused: boolean;
}

/** Messages a content script receives: from the background worker, or the popup's status query. */
export type ToContentMessage =
  | BackgroundToContentMessage
  /** Asks for the tab's current status; answered with `StatusReply`. */
  | { type: "get-status" };

export interface StatusReply {
  /** The last status the Refresh Scheduler commanded, or `null` before the first one. */
  status: SchedulerStatus | null;
}

export function sendToBackground(message: BackgroundMessage): Promise<unknown> {
  return chrome.runtime.sendMessage(message);
}

/** Sends to a tab's content script; rejects if there is none (not a board page, or still loading). */
export function sendToTab(tabId: number, message: ToContentMessage): Promise<unknown> {
  return chrome.tabs.sendMessage(tabId, message);
}
