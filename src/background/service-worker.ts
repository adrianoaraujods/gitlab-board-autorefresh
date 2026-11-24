/**
 * Background Service Worker. Owns the per-tab toolbar badge, the dynamic
 * content-script registrations, active-tab and window-focus tracking and
 * the per-tab pause state (#7).
 */
import {
  sendToTab,
  type BackgroundMessage,
  type PauseReply,
  type RefetchReply,
  type TabActivityResponse,
  type WindowFocusReply,
} from "../shared/messages";
import { onSettingsChanged } from "../shared/settings";
import { setTabBadge } from "./badge";
import { refetchBoardInPlace } from "./board-refetch";
import { syncContentScripts } from "./content-script-registry";
import { notifyTabActivity } from "./tab-activity";
import { forgetTab, isTabPaused, setTabPaused } from "./tab-pause";
import { isWindowFocused, notifyWindowFocus } from "./window-focus";

chrome.runtime.onInstalled.addListener(() => void syncContentScripts());
chrome.runtime.onStartup.addListener(() => void syncContentScripts());
chrome.permissions.onAdded.addListener(() => void syncContentScripts());
chrome.permissions.onRemoved.addListener(() => void syncContentScripts());
onSettingsChanged((keys) => {
  if (keys.includes("domains")) void syncContentScripts();
});

chrome.tabs.onActivated.addListener(({ windowId }) => void notifyTabActivity(windowId));
chrome.windows.onFocusChanged.addListener((windowId) => void notifyWindowFocus(windowId));

chrome.tabs.onRemoved.addListener((tabId) => void forgetTab(tabId));

chrome.runtime.onMessage.addListener((message: BackgroundMessage, sender, sendResponse) => {
  // Messages from the popup name their tab; content-script messages come from it.
  switch (message.type) {
    case "get-tab-pause":
      reply(isTabPaused(message.tabId), sendResponse);
      return true;
    case "set-tab-pause":
      reply(togglePause(message.tabId, message.paused), sendResponse);
      return true;
  }
  const tab = sender.tab;
  if (tab?.id === undefined) return;
  switch (message.type) {
    case "set-badge":
      void setTabBadge(tab.id, message.badge, message.count);
      return;
    case "get-tab-activity":
      sendResponse({ active: tab.active } satisfies TabActivityResponse);
      return;
    case "get-pause":
      reply(isTabPaused(tab.id), sendResponse);
      return true;
    case "refetch-board":
      void refetchBoardInPlace(tab.id).then((ok) => sendResponse({ ok } satisfies RefetchReply));
      return true;
    case "get-window-focus":
      void isWindowFocused(tab.windowId).then(
        (focused) => sendResponse({ focused } satisfies WindowFocusReply),
        // Unknown: treat as unfocused, as before window focus was tracked.
        () => sendResponse({ focused: false } satisfies WindowFocusReply),
      );
      return true;
  }
});

async function togglePause(tabId: number, paused: boolean): Promise<boolean> {
  await setTabPaused(tabId, paused);
  // No content script (not a board, or mid-reload): it reads the flag when it next loads.
  await sendToTab(tabId, { type: "pause-toggled", paused }).catch(() => undefined);
  return paused;
}

function reply(paused: Promise<boolean>, sendResponse: (response: PauseReply) => void): void {
  void paused.then(
    (value) => sendResponse({ paused: value }),
    (error: unknown) => {
      console.error("Pause state unavailable", error);
      sendResponse({ paused: false });
    },
  );
}
