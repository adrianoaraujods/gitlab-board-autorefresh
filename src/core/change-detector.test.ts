import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  buildFingerprintRequest,
  compare,
  readBoardContext,
  readCurrentUserId,
  type CompareContext,
} from "./change-detector";

/** Reads a hand-written, scrubbed GraphQL response modelled on GitLab 19.5 from `fixtures/gitlab-19.5/`. */
function fixture(name: string): any {
  return JSON.parse(readFileSync(new URL(`./fixtures/gitlab-19.5/${name}.json`, import.meta.url), "utf8"));
}

describe("Change Detector", () => {
  describe("board context", () => {
    it("reads a project board from its URL", () => {
      const url = "https://gitlab.example/group/project/-/boards/1?label_name[]=Doing";
      expect(readBoardContext(url, page(url))).toEqual({
        board: { fullPath: "group/project", boardId: "1", parent: "project" },
        graphqlUrl: "https://gitlab.example/api/graphql",
      });
    });

    it("reads a group board from its URL", () => {
      const url = "https://gitlab.example/groups/group/subgroup/-/boards/7";
      expect(readBoardContext(url, page(url))).toEqual({
        board: { fullPath: "group/subgroup", boardId: "7", parent: "group" },
        graphqlUrl: "https://gitlab.example/api/graphql",
      });
    });

    it("finds GitLab's subpath from the full path GitLab puts on the page", () => {
      const project = "https://example.com/gitlab/group/project/-/boards/3";
      expect(readBoardContext(project, page(project, 'data-project-full-path="group/project"'))).toEqual({
        board: { fullPath: "group/project", boardId: "3", parent: "project" },
        graphqlUrl: "https://example.com/gitlab/api/graphql",
      });
      const group = "https://example.com/gitlab/groups/group/-/boards/4";
      expect(readBoardContext(group, page(group, 'data-group-full-path="group"'))).toEqual({
        board: { fullPath: "group", boardId: "4", parent: "group" },
        graphqlUrl: "https://example.com/gitlab/api/graphql",
      });
    });

    it("can't tell which board is shown when the URL has no board id", () => {
      const url = "https://gitlab.example/group/project/-/boards";
      expect(readBoardContext(url, page(url))).toBeNull();
    });
  });

  describe("request", () => {
    it("asks for a project board by full path and board id", () => {
      const request = buildFingerprintRequest({
        fullPath: "group/project",
        boardId: "1",
        parent: "project",
      });
      expect(request.variables).toEqual({
        fullPath: "group/project",
        boardId: "gid://gitlab/Board/1",
        isProject: true,
        isGroup: false,
        first: 20,
      });
    });

    it("asks for a group board by full path and board id", () => {
      const request = buildFingerprintRequest({
        fullPath: "group/subgroup",
        boardId: "7",
        parent: "group",
      });
      expect(request.variables).toEqual({
        fullPath: "group/subgroup",
        boardId: "gid://gitlab/Board/7",
        isProject: false,
        isGroup: true,
        first: 20,
      });
    });

    it("sends one named query that never asks for the per-user collapsed flag", () => {
      const { query } = buildFingerprintRequest({
        fullPath: "group/project",
        boardId: "1",
        parent: "project",
      });
      expect(query).toMatch(/^query BoardAutoRefreshFingerprint\b/);
      expect(query).not.toMatch(/collapsed/);
    });
  });

  describe("comparing with the baseline", () => {
    it("reports nothing changed for identical data", () => {
      expect(compareWithProjectBoard(fixture("graphql-project-board")).kind).toBe("unchanged");
    });

    it("reports a group board unchanged against its own baseline", () => {
      const group = fixture("graphql-group-board");
      expect(compare(baselineOf(group), fixture("graphql-group-board")).kind).toBe("unchanged");
    });

    describe("reports a change when", () => {
      it("a card is added to a list", () => {
        const board = edited((lists) => {
          lists[2].issues.nodes.push(card("gid://gitlab/Issue/17", "2026-11-23T09:00:00Z"));
          lists[2].issuesCount = 1;
        });
        expect(compareWithProjectBoard(board)).toMatchObject({
          kind: "remote",
          changedCount: 1,
        });
      });

      it("a card is removed from a list (closed elsewhere, moved off the board, deleted)", () => {
        const board = edited((lists) => {
          lists[0].issues.nodes.splice(1, 1);
          lists[0].issuesCount = 1;
        });
        expect(compareWithProjectBoard(board)).toMatchObject({
          kind: "remote",
          changedCount: 1,
        });
      });

      it("a card moves to another list", () => {
        const board = edited((lists) => {
          const [moved] = lists[1].issues.nodes.splice(2, 1);
          lists[1].issuesCount = 2;
          lists[2].issues.nodes.push(moved);
          lists[2].issuesCount = 1;
        });
        expect(compareWithProjectBoard(board)).toMatchObject({
          kind: "remote",
          changedCount: 1,
        });
      });

      it("cards are reordered within a list, with no timestamp touched", () => {
        const board = edited((lists) => lists[1].issues.nodes.reverse());
        // Issues 13 and 15 swap places; 14 stays in the middle.
        expect(compareWithProjectBoard(board)).toMatchObject({
          kind: "remote",
          changedCount: 2,
        });
      });

      it("a card's fields are edited (its updatedAt moves on)", () => {
        const board = edited((lists) => (lists[0].issues.nodes[0].updatedAt = "2026-11-23T10:00:00Z"));
        expect(compareWithProjectBoard(board)).toMatchObject({
          kind: "remote",
          changedCount: 1,
        });
      });

      it("several cards are edited, counting each card once", () => {
        const board = edited((lists) => {
          lists[0].issues.nodes[0].updatedAt = "2026-11-23T10:00:00Z";
          lists[1].issues.nodes[1].updatedAt = "2026-11-23T10:00:05Z";
          lists[3].issues.nodes[0].updatedAt = "2026-11-23T10:00:09Z";
        });
        expect(compareWithProjectBoard(board)).toMatchObject({
          kind: "remote",
          changedCount: 3,
        });
      });

      it("a list is added", () => {
        const board = edited((lists) =>
          lists.splice(3, 0, {
            id: "gid://gitlab/List/5",
            title: "Blocked",
            listType: "label",
            position: 2,
            collapsed: false,
            label: {
              id: "gid://gitlab/ProjectLabel/23",
              title: "Blocked",
              color: "#dc143c",
            },
            issuesCount: 0,
            issues: { nodes: [] },
          }),
        );
        expect(compareWithProjectBoard(board)).toMatchObject({
          kind: "remote",
          changedCount: 1,
        });
      });

      it("an empty list is removed", () => {
        const board = edited((lists) => lists.splice(2, 1));
        expect(compareWithProjectBoard(board)).toMatchObject({
          kind: "remote",
          changedCount: 1,
        });
      });

      it("lists are reordered", () => {
        const board = edited((lists) => {
          const [doing, review] = lists.splice(1, 2);
          review.position = 0;
          doing.position = 1;
          lists.splice(1, 0, review, doing);
        });
        expect(compareWithProjectBoard(board).kind).toBe("remote");
      });

      it("a list's label is renamed or recoloured", () => {
        const renamed = edited((lists) => {
          lists[2].label.title = "In review";
          lists[2].title = "In review";
        });
        const recoloured = edited((lists) => (lists[2].label.color = "#ff8c00"));
        expect(compareWithProjectBoard(renamed)).toMatchObject({
          kind: "remote",
          changedCount: 1,
        });
        expect(compareWithProjectBoard(recoloured)).toMatchObject({
          kind: "remote",
          changedCount: 1,
        });
      });

      it("a list's total count changes beyond the cards fetched", () => {
        const board = edited((lists) => (lists[1].issuesCount = 24));
        expect(compareWithProjectBoard(board)).toMatchObject({
          kind: "remote",
          changedCount: 1,
        });
      });
    });

    describe("reports nothing changed when", () => {
      it("GitLab renumbers card positions but the order stays the same", () => {
        // The response carries order, not raw relativePosition: a renumbering returns the same cards in the same order.
        const board = edited((lists) => {
          for (const node of lists[1].issues.nodes) node.relativePosition = 513;
        });
        expect(compareWithProjectBoard(board).kind).toBe("unchanged");
      });

      it("a list is collapsed or expanded", () => {
        const board = edited((lists) => {
          lists[0].collapsed = true;
          lists[2].collapsed = false;
        });
        expect(compareWithProjectBoard(board).kind).toBe("unchanged");
      });
    });

    describe("own edits", () => {
      const ME = "gid://gitlab/User/3";
      const context = (extra: Partial<CompareContext> = {}): CompareContext => ({
        currentUserId: ME,
        localDrag: false,
        refreshAfterOwnEdits: false,
        ...extra,
      });
      const compareAs = (response: unknown, extra?: Partial<CompareContext>) =>
        compare(baselineOf(fixture("graphql-project-board")), response, context(extra));

      /** I edit card 13: it gets a new timestamp and my id. */
      const editedByMe = (lists: any[]) => {
        lists[1].issues.nodes[0].updatedAt = "2026-11-23T10:00:00Z";
        lists[1].issues.nodes[0].updatedBy = { id: ME };
      };

      it("is an own edit when the one changed card was last updated by me", () => {
        expect(compareAs(edited(editedByMe))).toMatchObject({
          kind: "own-edit",
        });
      });

      it("becomes the new baseline: the same data on the next check is unchanged", () => {
        const own = compareAs(edited(editedByMe));
        if (own.kind !== "own-edit") throw new Error("expected own-edit");
        expect(compare(own.fingerprint, edited(editedByMe), context()).kind).toBe("unchanged");
      });

      it("is an own edit when I move a card to another list (counts follow the card)", () => {
        const board = edited((lists) => {
          const [moved] = lists[1].issues.nodes.splice(2, 1);
          moved.updatedAt = "2026-11-23T10:00:00Z";
          moved.updatedBy = { id: ME };
          lists[1].issuesCount = 2;
          lists[2].issues.nodes.push(moved);
          lists[2].issuesCount = 1;
        });
        expect(compareAs(board).kind).toBe("own-edit");
      });

      it("is remote when someone else edited the card", () => {
        const board = edited((lists) => {
          lists[1].issues.nodes[0].updatedAt = "2026-11-23T10:00:00Z";
          lists[1].issues.nodes[0].updatedBy = { id: "gid://gitlab/User/2" };
        });
        expect(compareAs(board)).toMatchObject({
          kind: "remote",
          changedCount: 1,
        });
      });

      it("is remote when my edit is mixed with someone else's", () => {
        const board = edited((lists) => {
          editedByMe(lists);
          lists[0].issues.nodes[0].updatedAt = "2026-11-23T10:00:05Z";
          lists[0].issues.nodes[0].updatedBy = { id: "gid://gitlab/User/2" };
        });
        expect(compareAs(board)).toMatchObject({
          kind: "remote",
          changedCount: 2,
        });
      });

      it("is remote when a card disappeared, even if I edited another", () => {
        const board = edited((lists) => {
          editedByMe(lists);
          lists[0].issues.nodes.splice(1, 1);
          lists[0].issuesCount = 1;
        });
        expect(compareAs(board).kind).toBe("remote");
      });

      it("is remote when a list changed, even if I edited a card", () => {
        const board = edited((lists) => {
          editedByMe(lists);
          lists[2].label.title = "In review";
          lists[2].title = "In review";
        });
        expect(compareAs(board).kind).toBe("remote");
      });

      it("is remote when a list's total changed with no visible card change to explain it", () => {
        expect(compareAs(edited((lists) => (lists[1].issuesCount = 24))).kind).toBe("remote");
      });

      it("is remote when the current user is unknown", () => {
        expect(compareAs(edited(editedByMe), { currentUserId: null }).kind).toBe("remote");
      });

      it("treats an order-only change as an own edit when I finished a drag", () => {
        const board = edited((lists) => lists[1].issues.nodes.reverse());
        expect(compareAs(board, { localDrag: true })).toMatchObject({
          kind: "own-edit",
        });
      });

      it("treats an order-only change as remote without a drag of mine", () => {
        const board = edited((lists) => lists[1].issues.nodes.reverse());
        expect(compareAs(board, { localDrag: false })).toMatchObject({
          kind: "remote",
          changedCount: 2,
        });
      });

      it("does not excuse someone else's edit by a local drag", () => {
        const board = edited((lists) => {
          lists[1].issues.nodes.reverse();
          lists[0].issues.nodes[0].updatedAt = "2026-11-23T10:00:05Z";
          lists[0].issues.nodes[0].updatedBy = { id: "gid://gitlab/User/2" };
        });
        expect(compareAs(board, { localDrag: true }).kind).toBe("remote");
      });

      it("is remote for any difference when refreshing after my own edits", () => {
        expect(compareAs(edited(editedByMe), { refreshAfterOwnEdits: true }).kind).toBe("remote");
        const reordered = edited((lists) => lists[1].issues.nodes.reverse());
        expect(compareAs(reordered, { localDrag: true, refreshAfterOwnEdits: true }).kind).toBe("remote");
      });

      it("leaves an unchanged board unchanged", () => {
        expect(compareAs(fixture("graphql-project-board")).kind).toBe("unchanged");
      });
    });

    describe("current user", () => {
      const docWith = (script: string) =>
        new JSDOM(`<!doctype html><body><script>${script}</script></body>`, {
          url: "https://gitlab.example/",
        }).window.document;

      it("is read from the id GitLab puts in the page's inline data", () => {
        expect(readCurrentUserId(docWith("window.gon={};gon.current_user_id=42;gon.other=1"))).toBe(
          "gid://gitlab/User/42",
        );
        expect(readCurrentUserId(docWith('{"current_user_id":7}'))).toBe("gid://gitlab/User/7");
      });

      it("is unknown without one", () => {
        expect(readCurrentUserId(docWith("var a = 1;"))).toBeNull();
      });
    });

    describe("reports the response invalid when", () => {
      it("GraphQL answers with errors", () => {
        expect(compareWithProjectBoard(fixture("graphql-errors")).kind).toBe("invalid");
      });

      it("a list misses a field", () => {
        const board = edited((lists) => delete lists[1].issuesCount);
        expect(compareWithProjectBoard(board).kind).toBe("invalid");
      });

      it("a card misses a field", () => {
        const board = edited((lists) => delete lists[0].issues.nodes[1].updatedAt);
        expect(compareWithProjectBoard(board).kind).toBe("invalid");
      });

      it("there is no board", () => {
        expect(compareWithProjectBoard({ data: { project: { board: null } } }).kind).toBe("invalid");
        expect(compareWithProjectBoard({ data: null }).kind).toBe("invalid");
        expect(compareWithProjectBoard("<!doctype html>").kind).toBe("invalid");
      });

      it("there is no baseline yet", () => {
        expect(compare(null, fixture("graphql-errors")).kind).toBe("invalid");
      });
    });
  });
});

/** A minimal board page whose body carries `bodyAttributes`. */
function page(url: string, bodyAttributes = ""): Document {
  return new JSDOM(`<!doctype html><body data-page="projects:boards:show" ${bodyAttributes}></body>`, { url }).window.document;
}

/** The project board fixture with `edit` applied to its lists (in board order). */
function edited(edit: (lists: any[]) => unknown): unknown {
  const board = fixture("graphql-project-board");
  edit(board.data.project.board.lists.nodes);
  return board;
}

function card(id: string, updatedAt: string) {
  return { id, updatedAt, updatedBy: { id: "gid://gitlab/User/3" } };
}

/** Compares `response` with a baseline taken from the unedited project board fixture. */
function compareWithProjectBoard(response: unknown) {
  return compare(baselineOf(fixture("graphql-project-board")), response);
}

/** With no baseline yet, a valid response becomes the baseline. */
function baselineOf(response: unknown) {
  const taken = compare(null, response);
  if (taken.kind === "invalid") throw new Error(`fixture has no fingerprint: ${taken.problem}`);
  return taken.fingerprint;
}
