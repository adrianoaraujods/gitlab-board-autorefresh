/**
 * Background Service Worker. Owns the per-tab toolbar badge, the dynamic
 * content-script registrations and active-tab tracking. Later: per-tab pause
 * state (#7).
 */
import type { ContentToBackgroundMessage, TabActivityResponse } from "../shared/messages";
import { onSettingsChanged } from "../shared/settings";
import { setTabBadge } from "./badge";
import { syncContentScripts } from "./content-script-registry";
import { notifyTabActivity } from "./tab-activity";

chrome.runtime.onInstalled.addListener(() => void syncContentScripts());
chrome.runtime.onStartup.addListener(() => void syncContentScripts());
chrome.permissions.onAdded.addListener(() => void syncContentScripts());
chrome.permissions.onRemoved.addListener(() => void syncContentScripts());
onSettingsChanged((keys) => {
  if (keys.includes("domains")) void syncContentScripts();
});

chrome.tabs.onActivated.addListener(({ windowId }) => void notifyTabActivity(windowId));

chrome.runtime.onMessage.addListener((message: ContentToBackgroundMessage, sender, sendResponse) => {
  const tab = sender.tab;
  if (tab?.id === undefined) return;
  switch (message.type) {
    case "set-badge":
      void setTabBadge(tab.id, message.badge);
      return;
    case "get-tab-activity":
      sendResponse({ active: tab.active } satisfies TabActivityResponse);
      return;
  }
});
