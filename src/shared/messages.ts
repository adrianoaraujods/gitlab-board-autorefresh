import type { BadgeState } from "../core/badge";
import type { SchedulerStatus } from "../core/refresh-scheduler";

/** Messages sent from the content script to the background service worker. */
export type ContentToBackgroundMessage =
  | {
      type: "set-badge";
      /** `null` clears the badge (not a board page). */
      badge: BadgeState | null;
    }
  /** Asks whether the sending tab is paused. Replies with `PauseReply`. */
  | { type: "get-pause" };

/** Messages sent from the popup to the background service worker. */
export type PopupToBackgroundMessage =
  /** Asks whether `tabId` is paused. Replies with `PauseReply`. */
  | { type: "get-tab-pause"; tabId: number }
  /** Pauses or unpauses `tabId` and tells its content script. Replies with `PauseReply`. */
  | { type: "set-tab-pause"; tabId: number; paused: boolean };

export type BackgroundMessage = ContentToBackgroundMessage | PopupToBackgroundMessage;

export interface PauseReply {
  paused: boolean;
}

/** Messages sent to a tab's content script (from the service worker or the popup). */
export type ToContentMessage =
  | { type: "pause-toggled"; paused: boolean }
  /** Asks for the tab's current status. Replies with `StatusReply`. */
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
