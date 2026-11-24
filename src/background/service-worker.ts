/**
 * Background Service Worker. Owns the per-tab toolbar badge and the dynamic
 * content-script registrations, and the per-tab pause state (#7). Later:
 * active-tab tracking (#6).
 */
import { sendToTab, type BackgroundMessage, type PauseReply } from "../shared/messages";
import { onSettingsChanged } from "../shared/settings";
import { setTabBadge } from "./badge";
import { syncContentScripts } from "./content-script-registry";
import { forgetTab, isTabPaused, setTabPaused } from "./tab-pause";

chrome.runtime.onInstalled.addListener(() => void syncContentScripts());
chrome.runtime.onStartup.addListener(() => void syncContentScripts());
chrome.permissions.onAdded.addListener(() => void syncContentScripts());
chrome.permissions.onRemoved.addListener(() => void syncContentScripts());
onSettingsChanged((keys) => {
  if (keys.includes("domains")) void syncContentScripts();
});

chrome.tabs.onRemoved.addListener((tabId) => void forgetTab(tabId));

chrome.runtime.onMessage.addListener((message: BackgroundMessage, sender, sendResponse) => {
  const senderTabId = sender.tab?.id;
  switch (message.type) {
    case "set-badge":
      if (senderTabId !== undefined) void setTabBadge(senderTabId, message.badge);
      return;
    case "get-pause":
      if (senderTabId === undefined) return;
      reply(isTabPaused(senderTabId), sendResponse);
      return true;
    case "get-tab-pause":
      reply(isTabPaused(message.tabId), sendResponse);
      return true;
    case "set-tab-pause":
      reply(togglePause(message.tabId, message.paused), sendResponse);
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
