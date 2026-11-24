import { originMatchPattern } from "../core/domain-origin";
import { loadSettings } from "../shared/settings";

/**
 * Keeps one dynamically registered content script per configured origin that
 * the user has granted host access to. Registrations persist across browser
 * restarts; this reconciles them whenever domains or permissions change.
 */
const SCRIPT_ID_PREFIX = "board:";
const CONTENT_SCRIPT_FILE = "content-script.js";

let queue: Promise<void> = Promise.resolve();

/** Reconciles registrations with settings and permissions. Calls are serialised. */
export function syncContentScripts(): Promise<void> {
  queue = queue.then(reconcile, reconcile).catch((error: unknown) => {
    console.error("Failed to sync content scripts", error);
  });
  return queue;
}

async function reconcile(): Promise<void> {
  const { domains } = await loadSettings();
  const granted: string[] = [];
  for (const origin of domains) {
    if (await chrome.permissions.contains({ origins: [originMatchPattern(origin)] })) granted.push(origin);
  }
  const wantedIds = new Map(granted.map((origin) => [SCRIPT_ID_PREFIX + origin, origin]));

  const registered = await chrome.scripting.getRegisteredContentScripts();
  const ourIds = registered.map((script) => script.id).filter((id) => id.startsWith(SCRIPT_ID_PREFIX));

  const stale = ourIds.filter((id) => !wantedIds.has(id));
  if (stale.length > 0) await chrome.scripting.unregisterContentScripts({ ids: stale });

  const missing = [...wantedIds].filter(([id]) => !ourIds.includes(id));
  if (missing.length > 0) {
    await chrome.scripting.registerContentScripts(
      missing.map(([id, origin]) => ({
        id,
        matches: [originMatchPattern(origin)],
        js: [CONTENT_SCRIPT_FILE],
        runAt: "document_idle" as const,
        persistAcrossSessions: true,
      })),
    );
  }
}
