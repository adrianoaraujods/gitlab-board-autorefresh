/**
 * Board Page Matcher: decides from a URL whether a page is a project or group
 * issue board (or the sign-in page) on one of the configured origins.
 *
 * Boards are recognised by path only, so GitLab installed under a subpath
 * (e.g. `https://example.com/gitlab`) needs no extra configuration. Once a
 * board URL has loaded, `isBoardDocument` tells a board from an error page
 * served at that URL.
 */
export type BoardPageKind = "project-board" | "group-board" | "sign-in" | "none";

const BOARDS_PATH = /^(?<owner>.*)\/-\/boards(?:\/\d+)?\/?$/;
const SIGN_IN_PATH = /\/users\/(?:auth\/geo\/)?sign_in\/?$/;

export function matchBoardPage(url: string, configuredOrigins: readonly string[]): BoardPageKind {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "none";
  }
  if (!configuredOrigins.includes(parsed.origin)) return "none";

  const { pathname } = parsed;
  if (SIGN_IN_PATH.test(pathname)) return "sign-in";

  const board = BOARDS_PATH.exec(pathname);
  if (!board) return "none";
  const ownerSegments = (board.groups?.owner ?? "").split("/").filter(Boolean);
  return ownerSegments.includes("groups") ? "group-board" : "project-board";
}

export function isBoardPage(kind: BoardPageKind): boolean {
  return kind === "project-board" || kind === "group-board";
}

/** Server-rendered markers of a board page (GitLab 19.5 markup; see `fixtures/gitlab-19.5/`). */
const BOARD_DOCUMENT = [
  'body[data-page$="boards:index"]',
  'body[data-page$="boards:show"]',
  ".boards-app",
  ".js-focus-mode-board",
].join(", ");

/** Whether a loaded document carries GitLab's board markup (an HTTP error page at a board URL does not). */
export function isBoardDocument(document: Document): boolean {
  return document.querySelector(BOARD_DOCUMENT) !== null;
}
