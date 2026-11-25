/**
 * Change Detector (spec #10): the pure core of smart change detection. It
 * builds the one GraphQL request that fetches a board's fingerprint, and
 * compares a response with the baseline fingerprint taken earlier.
 *
 * A fingerprint keeps, per list, what its header shows and its total card
 * count, and per card (the first `CARDS_PER_LIST` of each list) its
 * `updatedAt` and its place: list and order index within the list. Order is
 * used instead of the raw `relativePosition`, so GitLab silently renumbering
 * positions with the same visible order is not a change.
 *
 * Extending: URL filters (#12) add a filter input to `BoardContext` and the
 * request; own-edit attribution (#15) adds a context argument to `compare`
 * and an `own-edit` kind to `ChangeDetection`; sign-out (#13) turns the
 * `no board` problem into a `signed-out` kind.
 */

/** Which board to fingerprint: a project or group board, by full path and numeric board id. */
export interface BoardContext {
  fullPath: string;
  boardId: string;
  parent: "project" | "group";
  /** The board's issue filter input built from the URL's filter params; absent when there are none, or when one isn't recognised. */
  filters?: BoardFilters;
}

/** GitLab's `BoardIssueInput`: the filters a board applies to its cards. */
export type BoardFilters = Record<string, unknown>;

/** The board a page shows, and where its instance answers GraphQL. */
export interface BoardPageContext {
  board: BoardContext;
  /** `<origin><subpath>/api/graphql`, same-origin with the board. */
  graphqlUrl: string;
}

const BOARD_PATH = /^(?<owner>\/.*?)\/-\/boards\/(?<boardId>\d+)\/?$/;

/**
 * Reads the board context from a board page. The board id comes from the URL
 * (`/-/boards/<id>`); a board URL without one gives `null`, since the page
 * doesn't say which board GitLab picked. The full path comes from the
 * `data-project-full-path` / `data-group-full-path` body attributes GitLab
 * sets, which also reveal a subpath install; without them the URL's owner
 * path is taken as the full path.
 */
export function readBoardContext(url: string, document: Document): BoardPageContext | null {
  const { origin, pathname } = new URL(url);
  const match = BOARD_PATH.exec(pathname);
  if (!match?.groups) return null;
  const owner = decodeURIComponent(match.groups.owner ?? "");
  const boardId = match.groups.boardId ?? "";
  const { projectFullPath, groupFullPath } = document.body?.dataset ?? {};

  const parent = projectFullPath ? "project" : groupFullPath ? "group" : /(^|\/)groups\//.test(owner) ? "group" : "project";
  // The owner path is `<subpath>/<full path>` for a project and `<subpath>/groups/<full path>` for a group.
  const ownerPrefix = parent === "group" ? "/groups/" : "/";
  const pageFullPath = projectFullPath || groupFullPath;
  const suffix = pageFullPath ? ownerPrefix + pageFullPath : null;
  const root = suffix && owner.endsWith(suffix) ? owner.slice(0, -suffix.length) : "";
  const fullPath = pageFullPath || owner.slice(ownerPrefix.length);
  return {
    board: { fullPath, boardId, parent, ...filtersOf(new URL(url).searchParams) },
    graphqlUrl: `${origin}${root}/api/graphql`,
  };
}

// URL filters -----------------------------------------------------------------

/** How a URL filter param maps to the issue filter input. `list` params always send an array. */
type FilterSpec = { field: string; kind: "string" | "list" | "boolean" | "number" | "iteration" };

/** The filter params GitLab 19.5's issue board writes to its URL, with the input field each maps to. */
const FILTERS: Record<string, FilterSpec> = {
  label_name: { field: "labelName", kind: "list" },
  assignee_username: { field: "assigneeUsername", kind: "string" },
  author_username: { field: "authorUsername", kind: "string" },
  milestone_title: { field: "milestoneTitle", kind: "string" },
  my_reaction_emoji: { field: "myReactionEmoji", kind: "string" },
  release_tag: { field: "releaseTag", kind: "string" },
  search: { field: "search", kind: "string" },
  weight: { field: "weight", kind: "string" },
  confidential: { field: "confidential", kind: "boolean" },
  types: { field: "types", kind: "list" },
  iteration_id: { field: "iterationId", kind: "iteration" },
};

/** Filters the board can negate (`not[...]`); in the negated input the user and type fields are lists. */
const NEGATED: Record<string, FilterSpec> = {
  label_name: { field: "labelName", kind: "list" },
  assignee_username: { field: "assigneeUsername", kind: "list" },
  author_username: { field: "authorUsername", kind: "string" },
  milestone_title: { field: "milestoneTitle", kind: "string" },
  my_reaction_emoji: { field: "myReactionEmoji", kind: "string" },
  release_tag: { field: "releaseTag", kind: "string" },
  types: { field: "types", kind: "list" },
};

/** Params that change how the page looks, not which cards it shows. */
const NON_FILTER_PARAMS = new Set(["utf8", "sort", "state", "page", "group_by"]);

/** Values the board's wildcard filters use, by field. */
const WILDCARDS: Record<string, { field: string; values: Record<string, string> }> = {
  assigneeUsername: { field: "assigneeWildcardId", values: { none: "NONE", any: "ANY" } },
  milestoneTitle: {
    field: "milestoneWildcardId",
    values: { none: "NONE", any: "ANY", upcoming: "UPCOMING", started: "STARTED", "#started": "STARTED" },
  },
};

/**
 * Maps a board URL's filter params to the board's issue filter input. Returns
 * `{ filters }`, or `{}` when there are no filters or any param isn't
 * recognised: the query then runs unfiltered, a superset, so a visible change
 * can never be missed.
 */
function filtersOf(params: URLSearchParams): { filters?: BoardFilters } {
  const filters: BoardFilters = {};
  const negated: BoardFilters = {};
  const seen = new Set<string>();
  for (const [key, value] of params) {
    const match = /^(?<not>not\[)?(?<name>[a-z0-9_]+)\]?(?<list>\[\])?$/.exec(key);
    if (!match?.groups) return {};
    const name = match.groups.name ?? "";
    if (!match.groups.not && NON_FILTER_PARAMS.has(name)) continue;
    const spec = (match.groups.not ? NEGATED : FILTERS)[name];
    if (!spec || value === "") return {};
    const target = match.groups.not ? negated : filters;
    const isList = spec.kind === "list";
    // A param given twice is only valid as a list; anything else is ambiguous.
    if (!isList && seen.has(key.replace("[]", ""))) return {};
    seen.add(key.replace("[]", ""));
    const converted = convert(spec, value, !match.groups.not);
    if (converted === null) return {};
    if (isList) {
      const current = (target[converted.field] as unknown[] | undefined) ?? [];
      target[converted.field] = [...current, converted.value];
    } else {
      target[converted.field] = converted.value;
    }
  }
  if (Object.keys(negated).length > 0) filters.not = negated;
  return Object.keys(filters).length > 0 ? { filters } : {};
}

/** The input field and value for one param value, or `null` when the value can't be mapped. */
function convert(spec: FilterSpec, value: string, positive: boolean): { field: string; value: unknown } | null {
  const wildcard = positive ? WILDCARDS[spec.field] : undefined;
  if (wildcard) {
    const id = wildcard.values[value.toLowerCase()];
    if (id) return { field: wildcard.field, value: id };
  }
  switch (spec.kind) {
    case "boolean":
      return value === "true" || value === "false" ? { field: spec.field, value: value === "true" } : null;
    case "iteration":
      return /^\d+$/.test(value) ? { field: spec.field, value: `gid://gitlab/Iteration/${value}` } : null;
    default:
      return { field: spec.field, value };
  }
}

/** Cards fingerprinted per list; changes further down show through the list's total count. */
export const CARDS_PER_LIST = 20;

export interface FingerprintRequest {
  query: string;
  variables: {
    fullPath: string;
    boardId: string;
    isProject: boolean;
    isGroup: boolean;
    first: number;
    filters?: BoardFilters;
  };
}

/**
 * One request per check (GitLab 19.5 schema): each list's header fields and
 * total count, and the first cards of each list in board order with when and
 * by whom they last changed. `updatedBy` is for own-edit attribution (#15).
 * The per-user `collapsed` flag is never fetched, so collapsing a list in
 * another tab is not a change.
 */
const QUERY = `query BoardAutoRefreshFingerprint($fullPath: ID!, $boardId: BoardID!, $isProject: Boolean = false, $isGroup: Boolean = false, $first: Int, $filters: BoardIssueInput) {
  project(fullPath: $fullPath) @include(if: $isProject) {
    board(id: $boardId) {
      ...BoardAutoRefreshLists
    }
  }
  group(fullPath: $fullPath) @include(if: $isGroup) {
    board(id: $boardId) {
      ...BoardAutoRefreshLists
    }
  }
}

fragment BoardAutoRefreshLists on Board {
  id
  lists(issueFilters: $filters) {
    nodes {
      id
      title
      listType
      position
      label {
        id
        title
        color
      }
      issuesCount
      issues(first: $first, filters: $filters) {
        nodes {
          id
          updatedAt
          updatedBy {
            id
          }
        }
      }
    }
  }
}
`;

export function buildFingerprintRequest(context: BoardContext): FingerprintRequest {
  return {
    query: QUERY,
    variables: {
      fullPath: context.fullPath,
      boardId: `gid://gitlab/Board/${context.boardId}`,
      isProject: context.parent === "project",
      isGroup: context.parent === "group",
      first: CARDS_PER_LIST,
      ...(context.filters && { filters: context.filters }),
    },
  };
}

/**
 * What the board showed at one check, small enough to persist per tab. Treat
 * it as opaque: only `compare` reads it.
 */
export interface BoardFingerprint {
  /** Lists in board order, each keyed by what its header shows, with its total card count apart. */
  lists: { id: string; key: string; count: number }[];
  /** Card id → when it last changed and where it sits (list and order index within the list). */
  cards: Record<string, string>;
}

/**
 * The result of a check. `unchanged`, `own-edit` and `remote` carry the
 * fingerprint of the response, to become the next baseline once the caller
 * has acted on it (at once for `unchanged` and `own-edit`: nothing to reload).
 * `own-edit` means every difference is the current user's own work.
 * `remote.changedCount` is the number of cards added, removed or changed, and
 * at least 1 when only the lists changed. `invalid` means the response wasn't
 * the expected shape (GraphQL errors, a missing field). `signed-out` means
 * GitLab answered with a null project, group or board: an expired session
 * queries as anonymous and gets nulls instead of a 401.
 */
export type ChangeDetection =
  | { kind: "unchanged"; fingerprint: BoardFingerprint }
  | { kind: "own-edit"; fingerprint: BoardFingerprint }
  | { kind: "remote"; changedCount: number; fingerprint: BoardFingerprint }
  | { kind: "signed-out" }
  | { kind: "invalid"; problem: string };

/** What the adapter knows about the current user's activity in this tab (#15). */
export interface CompareContext {
  /** The current user as GitLab's `updatedBy.id` shows it, or `null` if the page doesn't say. */
  currentUserId: string | null;
  /** A card drag finished in this tab since the baseline (or last check). */
  localDrag: boolean;
  /** "Refresh after my own edits": any difference is `remote`. */
  refreshAfterOwnEdits: boolean;
}

const NO_CONTEXT: CompareContext = {
  currentUserId: null,
  localDrag: false,
  refreshAfterOwnEdits: false,
};

/**
 * Compares a fingerprint response (the parsed GraphQL JSON body) with the
 * baseline. With no baseline yet, a valid response is `unchanged` and its
 * fingerprint becomes the baseline.
 *
 * A difference is an `own-edit` (unless `refreshAfterOwnEdits`) when the
 * lists' structure is the same and either every changed card is still on the
 * board and was last updated by the current user, or only the order changed
 * (no card's `updatedAt` moved) after a local drag. Anything else, including
 * a list total that no visible card change explains, is `remote`.
 */
export function compare(
  baseline: BoardFingerprint | null,
  response: unknown,
  context: CompareContext = NO_CONTEXT,
): ChangeDetection {
  const read = readFingerprint(response);
  if (read === SIGNED_OUT) return { kind: "signed-out" };
  if (typeof read === "string") return { kind: "invalid", problem: read };
  const { fingerprint, editors } = read;
  if (baseline === null) return { kind: "unchanged", fingerprint };
  const changedIds = changedCardIds(baseline.cards, fingerprint.cards);
  const structureChanged = !sameLists(baseline.lists, fingerprint.lists, (list) => list.key);
  const countsChanged = !sameLists(baseline.lists, fingerprint.lists, (list) => String(list.count));
  if (changedIds.length === 0 && !structureChanged && !countsChanged) return { kind: "unchanged", fingerprint };
  const remote: ChangeDetection = {
    kind: "remote",
    changedCount: Math.max(changedIds.length, 1),
    fingerprint,
  };
  if (context.refreshAfterOwnEdits || structureChanged || changedIds.length === 0) return remote;

  const updatedAt = (card: string | undefined) => card?.split(" ")[0];
  const orderOnly =
    !countsChanged && changedIds.every((id) => updatedAt(baseline.cards[id]) === updatedAt(fingerprint.cards[id]));
  if (orderOnly) return context.localDrag ? { kind: "own-edit", fingerprint } : remote;
  const allMine =
    context.currentUserId !== null &&
    changedIds.every((id) => id in fingerprint.cards && editors.get(id) === context.currentUserId);
  return allMine ? { kind: "own-edit", fingerprint } : remote;
}

function changedCardIds(before: Record<string, string>, after: Record<string, string>): string[] {
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...ids].filter((id) => before[id] !== after[id]);
}

/** Whether both have the same lists in the same order, and `part` of each is equal. */
function sameLists(
  a: BoardFingerprint["lists"],
  b: BoardFingerprint["lists"],
  part: (list: BoardFingerprint["lists"][number]) => string,
): boolean {
  return (
    a.length === b.length &&
    a.every((list, i) => b[i] !== undefined && list.id === b[i].id && part(list) === part(b[i]))
  );
}

/**
 * The current user's id as GitLab's GraphQL shows it, read from the page's
 * inline data (`gon.current_user_id`); `null` if the page doesn't carry it.
 * Content scripts can't read the page's `window.gon`, so the script text is read.
 */
export function readCurrentUserId(document: Document): string | null {
  for (const script of document.querySelectorAll("script:not([src])")) {
    const match = /current_user_id["']?\s*[=:]\s*(\d+)/.exec(script.textContent ?? "");
    if (match) return `gid://gitlab/User/${match[1]}`;
  }
  return null;
}

// Reading the response ----------------------------------------------------------

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SIGNED_OUT = Symbol("signed-out");

/** The response's fingerprint with who last updated each card, what is wrong with it, or `SIGNED_OUT`. */
function readFingerprint(
  response: unknown,
): { fingerprint: BoardFingerprint; editors: Map<string, string | null> } | string | typeof SIGNED_OUT {
  if (!isObject(response)) return "response is not a JSON object";
  if (Array.isArray(response.errors) && response.errors.length > 0) return "GraphQL errors";
  const { data } = response;
  if (!isObject(data)) return "no data";
  const parent = data.project !== undefined ? data.project : data.group;
  if (parent === null || (isObject(parent) && parent.board === null)) return SIGNED_OUT;
  if (!isObject(parent) || !isObject(parent.board)) return "no board";
  const lists = parent.board.lists;
  if (!isObject(lists) || !Array.isArray(lists.nodes)) return "no lists";

  const fingerprint: BoardFingerprint = { lists: [], cards: {} };
  const editors = new Map<string, string | null>();
  const placements = new Map<string, { updatedAt: string; at: string[] }>();
  for (const list of lists.nodes) {
    const key = listKey(list);
    if (key === null || !isObject(list)) return "unexpected list";
    const id = list.id as string;
    fingerprint.lists.push({ id, key, count: list.issuesCount as number });
    const issues = list.issues;
    if (!isObject(issues) || !Array.isArray(issues.nodes)) return "no cards";
    for (const [index, card] of issues.nodes.entries()) {
      if (!isObject(card) || typeof card.id !== "string" || typeof card.updatedAt !== "string") return "unexpected card";
      const by = card.updatedBy;
      editors.set(card.id, isObject(by) && typeof by.id === "string" ? by.id : null);
      // An issue can show in several lists (one per matching label): one entry, all its places.
      const entry = placements.get(card.id) ?? {
        updatedAt: card.updatedAt,
        at: [],
      };
      entry.at.push(`${id}#${index}`);
      placements.set(card.id, entry);
    }
  }
  for (const [id, { updatedAt, at }] of placements) fingerprint.cards[id] = [updatedAt, ...at.sort()].join(" ");
  return { fingerprint, editors };
}

/** What a list's header shows (not its total card count, kept apart), or `null` if a field is missing. The per-user `collapsed` flag is left out. */
function listKey(list: unknown): string | null {
  if (!isObject(list) || typeof list.id !== "string" || typeof list.listType !== "string") return null;
  if (typeof list.issuesCount !== "number") return null;
  if (!(typeof list.title === "string" || list.title === null)) return null;
  if (!(typeof list.position === "number" || list.position === null)) return null;
  const { label } = list;
  if (label !== null && !(isObject(label) && typeof label.id === "string")) return null;
  const labelKey = label === null ? null : [label.id, label.title, label.color];
  return JSON.stringify([list.listType, list.title, list.position, labelKey]);
}
