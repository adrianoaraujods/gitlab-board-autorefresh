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
  /** Lists in board order, each keyed by what its header shows and its total card count. */
  lists: { id: string; key: string }[];
  /** Card id → when it last changed and where it sits (list and order index within the list). */
  cards: Record<string, string>;
}

/**
 * The result of a check. `unchanged` and `remote` carry the fingerprint of the
 * response, to become the next baseline once the caller has acted on it.
 * `remote.changedCount` is the number of cards added, removed or changed, and
 * at least 1 when only the lists changed. `invalid` means the response wasn't
 * the expected shape (GraphQL errors, a missing field, no board).
 */
export type ChangeDetection =
  | { kind: "unchanged"; fingerprint: BoardFingerprint }
  | { kind: "remote"; changedCount: number; fingerprint: BoardFingerprint }
  | { kind: "invalid"; problem: string };

/**
 * Compares a fingerprint response (the parsed GraphQL JSON body) with the
 * baseline. With no baseline yet, a valid response is `unchanged` and its
 * fingerprint becomes the baseline.
 */
export function compare(baseline: BoardFingerprint | null, response: unknown): ChangeDetection {
  const read = readFingerprint(response);
  if (typeof read === "string") return { kind: "invalid", problem: read };
  if (baseline === null) return { kind: "unchanged", fingerprint: read };
  const changedCards = countChangedCards(baseline.cards, read.cards);
  const listsChanged = !sameLists(baseline.lists, read.lists);
  if (changedCards === 0 && !listsChanged) return { kind: "unchanged", fingerprint: read };
  return { kind: "remote", changedCount: Math.max(changedCards, 1), fingerprint: read };
}

function countChangedCards(before: Record<string, string>, after: Record<string, string>): number {
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...ids].filter((id) => before[id] !== after[id]).length;
}

function sameLists(a: BoardFingerprint["lists"], b: BoardFingerprint["lists"]): boolean {
  return a.length === b.length && a.every((list, i) => list.id === b[i]?.id && list.key === b[i]?.key);
}

// Reading the response ----------------------------------------------------------

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The response's fingerprint, or what is wrong with it. */
function readFingerprint(response: unknown): BoardFingerprint | string {
  if (!isObject(response)) return "response is not a JSON object";
  if (Array.isArray(response.errors) && response.errors.length > 0) return "GraphQL errors";
  const { data } = response;
  if (!isObject(data)) return "no data";
  const parent = data.project ?? data.group;
  if (!isObject(parent) || !isObject(parent.board)) return "no board";
  const lists = parent.board.lists;
  if (!isObject(lists) || !Array.isArray(lists.nodes)) return "no lists";

  const fingerprint: BoardFingerprint = { lists: [], cards: {} };
  const placements = new Map<string, { updatedAt: string; at: string[] }>();
  for (const list of lists.nodes) {
    const key = listKey(list);
    if (key === null || !isObject(list)) return "unexpected list";
    const id = list.id as string;
    fingerprint.lists.push({ id, key });
    const issues = list.issues;
    if (!isObject(issues) || !Array.isArray(issues.nodes)) return "no cards";
    for (const [index, card] of issues.nodes.entries()) {
      if (!isObject(card) || typeof card.id !== "string" || typeof card.updatedAt !== "string") return "unexpected card";
      // An issue can show in several lists (one per matching label): one entry, all its places.
      const entry = placements.get(card.id) ?? { updatedAt: card.updatedAt, at: [] };
      entry.at.push(`${id}#${index}`);
      placements.set(card.id, entry);
    }
  }
  for (const [id, { updatedAt, at }] of placements) fingerprint.cards[id] = [updatedAt, ...at.sort()].join(" ");
  return fingerprint;
}

/** What a list's header shows and its total card count, or `null` if a field is missing. The per-user `collapsed` flag is left out. */
function listKey(list: unknown): string | null {
  if (!isObject(list) || typeof list.id !== "string" || typeof list.listType !== "string") return null;
  if (typeof list.issuesCount !== "number") return null;
  if (!(typeof list.title === "string" || list.title === null)) return null;
  if (!(typeof list.position === "number" || list.position === null)) return null;
  const { label } = list;
  if (label !== null && !(isObject(label) && typeof label.id === "string")) return null;
  const labelKey = label === null ? null : [label.id, label.title, label.color];
  return JSON.stringify([list.listType, list.title, list.position, labelKey, list.issuesCount]);
}
