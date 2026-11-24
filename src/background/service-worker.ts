/**
 * Background Service Worker. Owns the per-tab toolbar badge and the dynamic
 * content-script registrations. Later: active-tab tracking (#6) and per-tab
 * pause state (#7).
 */
import type { ContentToBackgroundMessage } from "../shared/messages";
import { onSettingsChanged } from "../shared/settings";
import { setTabBadge } from "./badge";
import { syncContentScripts } from "./content-script-registry";

chrome.runtime.onInstalled.addListener(() => void syncContentScripts());
chrome.runtime.onStartup.addListener(() => void syncContentScripts());
chrome.permissions.onAdded.addListener(() => void syncContentScripts());
chrome.permissions.onRemoved.addListener(() => void syncContentScripts());
onSettingsChanged((keys) => {
  if (keys.includes("domains")) void syncContentScripts();
});

chrome.runtime.onMessage.addListener((message: ContentToBackgroundMessage, sender) => {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;
  if (message.type === "set-badge") void setTabBadge(tabId, message.badge);
});
