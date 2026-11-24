/**
 * Scroll Snapshot (spec #1, ticket #5). Right before an auto-refresh reload,
 * `saveScrollSnapshot` stores the page scroll and each list column's scroll in
 * the tab's sessionStorage, keyed by URL. After the reload,
 * `restoreScrollSnapshot` takes that snapshot and scrolls everything back,
 * retrying as the lazily rendered lists mount and page in their cards, until
 * every position is reached or the timeout expires.
 *
 * A snapshot is removed as soon as a load reads it and is only trusted for
 * `maxAgeMs` after it was saved, so a manual reload never restores a stale one.
 */

/** The page-level vertical scroller on GitLab 19.5 boards (fallback: the document scroller). */
const PAGE_SCROLLER = ".js-static-panel-inner";
/** A list column's vertical scroller; `data-board` holds the list's stable GID. */
const LIST_SCROLLER = "ul.board-list[data-board]";

const KEY_PREFIX = "gitlab-board-autorefresh:scroll:";

/** A reload normally lands within seconds; anything older did not come from it. */
export const DEFAULT_MAX_AGE_MS = 60_000;

interface ScrollPosition {
  top: number;
  left: number;
}

interface Snapshot {
  savedAt: number;
  page: ScrollPosition;
  /** Keyed by the list's `data-board` GID, not its position: users reorder columns. */
  lists: Record<string, ScrollPosition>;
}

export interface SaveOptions {
  /** The page URL; snapshots are keyed by it so boards and filters don't clobber each other. */
  url: string;
  now: number;
}

export interface RestoreOptions {
  url: string;
  now: number;
  /** How long to wait for lists to render and fill before giving up. */
  timeoutMs: number;
  /** Ignore snapshots saved longer ago than this. Default `DEFAULT_MAX_AGE_MS`. */
  maxAgeMs?: number;
}

export type RestoreOutcome = "restored" | "timed-out" | "no-snapshot";

export function saveScrollSnapshot(doc: Document, storage: Storage, options: SaveOptions): void {
  const pageEl = pageScroller(doc);
  const lists: Record<string, ScrollPosition> = {};
  for (const ul of doc.querySelectorAll<HTMLElement>(LIST_SCROLLER)) {
    // Unscrolled lists (including collapsed ones, which report 0) need no restore.
    if (ul.scrollTop === 0 && ul.scrollLeft === 0) continue;
    lists[ul.dataset.board!] = positionOf(ul);
  }
  const snapshot: Snapshot = { savedAt: options.now, page: positionOf(pageEl), lists };
  storage.setItem(KEY_PREFIX + options.url, JSON.stringify(snapshot));
}

export function restoreScrollSnapshot(
  doc: Document,
  storage: Storage,
  options: RestoreOptions,
): Promise<RestoreOutcome> {
  const snapshot = takeSnapshot(storage, options);
  if (!snapshot) return Promise.resolve("no-snapshot");

  /** Scroll targets still to reach, each with how to find its element. */
  const pending = new Map<string, { find: () => Element | null; position: ScrollPosition }>();
  pending.set("page", { find: () => pageScroller(doc), position: snapshot.page });
  for (const [id, position] of Object.entries(snapshot.lists)) {
    const selector = `${LIST_SCROLLER}[data-board="${CSS.escape(id)}"]`;
    pending.set(`list:${id}`, { find: () => doc.querySelector(selector), position });
  }

  /** Applies every pending target whose element exists; drops those that reached their position. */
  const attempt = (): void => {
    for (const [key, { find, position }] of pending) {
      const el = find();
      if (el && apply(el, position)) pending.delete(key);
    }
  };

  return new Promise((resolve) => {
    attempt();
    if (pending.size === 0) return resolve("restored");

    const finish = (outcome: RestoreOutcome): void => {
      observer.disconnect();
      clearTimeout(timer);
      resolve(outcome);
    };
    // Lists mount lazily and page in 10 cards at a time, so retry on every DOM change.
    const observer = new MutationObserver(() => {
      attempt();
      if (pending.size === 0) finish("restored");
    });
    observer.observe(doc, { childList: true, subtree: true });
    const timer = setTimeout(() => finish("timed-out"), options.timeoutMs);
  });
}

/** Reads and removes the snapshot for this URL; null if absent, unreadable or too old. */
function takeSnapshot(storage: Storage, options: RestoreOptions): Snapshot | null {
  const key = KEY_PREFIX + options.url;
  const raw = storage.getItem(key);
  if (raw === null) return null;
  storage.removeItem(key);
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isSnapshot(snapshot)) return null;
  const age = options.now - snapshot.savedAt;
  return age >= 0 && age <= (options.maxAgeMs ?? DEFAULT_MAX_AGE_MS) ? snapshot : null;
}

function isSnapshot(value: unknown): value is Snapshot {
  const v = value as Partial<Snapshot> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.savedAt === "number" &&
    typeof v.page === "object" &&
    v.page !== null &&
    typeof v.lists === "object" &&
    v.lists !== null
  );
}

/** GitLab's static panel scrolls the page; other layouts scroll the document itself. */
function pageScroller(doc: Document): Element {
  return doc.querySelector(PAGE_SCROLLER) ?? doc.scrollingElement ?? doc.documentElement;
}

function positionOf(el: Element): ScrollPosition {
  return { top: el.scrollTop, left: el.scrollLeft };
}

/** Scrolls `el` towards `position`; true once it got there (the content may still be too short). */
function apply(el: Element, position: ScrollPosition): boolean {
  el.scrollTop = position.top;
  el.scrollLeft = position.left;
  return Math.abs(el.scrollTop - position.top) < 1 && Math.abs(el.scrollLeft - position.left) < 1;
}
