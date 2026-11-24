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
  | { type: "get-pause" }
  /** Asks whether the sender tab's browser window is the focused Chrome window; answered with `WindowFocusReply`. */
  | { type: "get-window-focus" }
  /** Asks the worker to refetch the sender tab's board data in place; answered with `RefetchReply`. */
  | { type: "refetch-board" };

export interface RefetchReply {
  /** Whether the board's data layer was found and refetched. */
  ok: boolean;
}

export interface TabActivityResponse {
  active: boolean;
}

export interface WindowFocusReply {
  focused: boolean;
}

/** Messages sent from the background service worker to a content script. */
export type BackgroundToContentMessage =
  | {
      type: "tab-activity-changed";
      /** Whether the receiving tab is now the active tab of its window. */
      active: boolean;
    }
  | { type: "pause-toggled"; paused: boolean }
  | {
      type: "window-focus-changed";
      /** Whether the receiving tab's browser window is now the focused Chrome window. */
      focused: boolean;
    };

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

/** The reply each message to the background worker is answered with (`void`: not answered). */
interface BackgroundReplies {
  "set-badge": void;
  "get-tab-activity": TabActivityResponse;
  "get-pause": PauseReply;
  "get-window-focus": WindowFocusReply;
  "refetch-board": RefetchReply;
  "get-tab-pause": PauseReply;
  "set-tab-pause": PauseReply;
}

/** The reply each message to a content script is answered with (`void`: not answered). */
interface ContentReplies {
  "tab-activity-changed": void;
  "pause-toggled": void;
  "window-focus-changed": void;
  "get-status": StatusReply;
}

export type BackgroundReply<M extends BackgroundMessage> = BackgroundReplies[M["type"]];
export type ContentReply<M extends ToContentMessage> = ContentReplies[M["type"]];

/**
 * Sends to the background worker and resolves with the reply for that message
 * type, or `undefined` if nothing answered.
 */
export function sendToBackground<M extends BackgroundMessage>(message: M): Promise<BackgroundReply<M> | undefined> {
  return chrome.runtime.sendMessage(message);
}

/**
 * Sends to a tab's content script and resolves with the reply for that message
 * type; rejects if there is no content script (not a board page, or still loading).
 */
export function sendToTab<M extends ToContentMessage>(tabId: number, message: M): Promise<ContentReply<M> | undefined> {
  return chrome.tabs.sendMessage(tabId, message);
}
