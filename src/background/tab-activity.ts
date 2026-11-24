import type { BackgroundToContentMessage } from "../shared/messages";

/**
 * Tells every tab in a window whether it is now the window's active tab. Called
 * when the active tab changes. Asking the browser each time keeps the service
 * worker stateless, so nothing is lost when it is shut down. Tabs without the
 * content script (non-board pages) reject the message, which is ignored.
 */
export async function notifyTabActivity(windowId: number): Promise<void> {
  const tabs = await chrome.tabs.query({ windowId });
  await Promise.all(
    tabs.map(({ id, active }) => {
      if (id === undefined) return;
      const message: BackgroundToContentMessage = { type: "tab-activity-changed", active };
      return chrome.tabs.sendMessage(id, message).catch(() => undefined);
    }),
  );
}
