/**
 * Per-tab pause state, kept for the life of the tab. Stored in
 * chrome.storage.session because the service worker's globals die with it;
 * cleared when the tab closes (and on browser restart or extension reload).
 */
const keyFor = (tabId: number) => `pause:${tabId}`;

export async function isTabPaused(tabId: number): Promise<boolean> {
  const key = keyFor(tabId);
  const stored = await chrome.storage.session.get(key);
  return stored[key] === true;
}

export async function setTabPaused(tabId: number, paused: boolean): Promise<void> {
  const key = keyFor(tabId);
  if (paused) await chrome.storage.session.set({ [key]: true });
  else await chrome.storage.session.remove(key);
}

export async function forgetTab(tabId: number): Promise<void> {
  await chrome.storage.session.remove(keyFor(tabId));
}
