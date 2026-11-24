import type { BackgroundToContentMessage } from "../shared/messages";

/**
 * Which browser window has focus, for the Refresh Scheduler's window-focus
 * input. The page also gets a DOM `blur` when the toolbar popup or the omnibox
 * takes focus, so DOM focus alone can't tell "the user went elsewhere" from
 * "the user is using this window's browser UI".
 *
 * Asking the browser each time keeps the service worker stateless, so nothing
 * is lost when it is shut down.
 */

/** Whether `windowId` is the focused Chrome window (false while another app has focus). */
export async function isWindowFocused(windowId: number): Promise<boolean> {
  const window = await chrome.windows.getLastFocused();
  return window.focused && window.id === windowId;
}

/**
 * Tells every tab whether its window is now the focused window. Called from
 * `windows.onFocusChanged`, where `WINDOW_ID_NONE` means another app has focus.
 * Tabs without the content script reject the message, which is ignored.
 */
export async function notifyWindowFocus(focusedWindowId: number): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map(({ id, windowId }) => {
      if (id === undefined) return;
      const focused = focusedWindowId !== chrome.windows.WINDOW_ID_NONE && windowId === focusedWindowId;
      const message: BackgroundToContentMessage = { type: "window-focus-changed", focused };
      return chrome.tabs.sendMessage(id, message).catch(() => undefined);
    }),
  );
}
