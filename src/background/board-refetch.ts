/**
 * Update in place (#17, experimental): refetches the board's active Apollo
 * queries from the page's own JavaScript world, so the board redraws changed
 * cards with no reload. It relies on GitLab's Vue 2 board internals, so every
 * call feature-detects the client and reports `false` when it isn't there or
 * the refetch fails; the content script then reloads.
 */

/** Runs in the page's world: must stay self-contained (it is serialised into the tab). */
function refetchBoardQueries(): Promise<boolean> {
  type Client = { reFetchObservableQueries?: () => Promise<unknown> };
  type VueInstance = { $apollo?: { provider?: { defaultClient?: Client } }; $apolloProvider?: { defaultClient?: Client } };
  const root = document.querySelector<HTMLElement & { __vue__?: VueInstance }>(".boards-app");
  const vm = root?.__vue__;
  const client = vm?.$apolloProvider?.defaultClient ?? vm?.$apollo?.provider?.defaultClient;
  if (typeof client?.reFetchObservableQueries !== "function") return Promise.resolve(false);
  return client.reFetchObservableQueries().then(
    () => true,
    () => false,
  );
}

/** Whether the board in `tabId` refetched its data in place. */
export async function refetchBoardInPlace(tabId: number): Promise<boolean> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: refetchBoardQueries,
    });
    return result?.result === true;
  } catch {
    return false;
  }
}
