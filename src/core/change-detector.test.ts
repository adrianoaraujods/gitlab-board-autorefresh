import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { buildFingerprintRequest, compare, readBoardContext } from "./change-detector";

/** Reads a hand-written, scrubbed GraphQL response modelled on GitLab 19.5 from `fixtures/gitlab-19.5/`. */
function fixture(name: string): any {
  return JSON.parse(readFileSync(new URL(`./fixtures/gitlab-19.5/${name}.json`, import.meta.url), "utf8"));
}

describe("Change Detector", () => {
  describe("board context", () => {
    it("reads a project board from its URL", () => {
      const url = "https://gitlab.example/group/project/-/boards/1?label_name[]=Doing";
      expect(readBoardContext(url, page(url))).toEqual({
        board: { fullPath: "group/project", boardId: "1", parent: "project", filters: { labelName: ["Doing"] } },
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
      const request = buildFingerprintRequest({ fullPath: "group/project", boardId: "1", parent: "project" });
      expect(request.variables).toEqual({
        fullPath: "group/project",
        boardId: "gid://gitlab/Board/1",
        isProject: true,
        isGroup: false,
        first: 20,
      });
    });

    it("asks for a group board by full path and board id", () => {
      const request = buildFingerprintRequest({ fullPath: "group/subgroup", boardId: "7", parent: "group" });
      expect(request.variables).toEqual({
        fullPath: "group/subgroup",
        boardId: "gid://gitlab/Board/7",
        isProject: false,
        isGroup: true,
        first: 20,
      });
    });

    it("sends one named query that never asks for the per-user collapsed flag", () => {
      const { query } = buildFingerprintRequest({ fullPath: "group/project", boardId: "1", parent: "project" });
      expect(query).toMatch(/^query BoardAutoRefreshFingerprint\b/);
      expect(query).not.toMatch(/collapsed/);
    });
  });

  describe("URL filters", () => {
    const BASE = "https://gitlab.example/group/project/-/boards/1";
    /** The filter variable the request sends for a board URL's query string. */
    function filtersFor(search: string, base = BASE): unknown {
      const url = `${base}${search}`;
      const request = buildFingerprintRequest(readBoardContext(url, page(url))!.board);
      return (request.variables as Record<string, unknown>).filters;
    }

    it.each([
      ["label_name[]=Doing", { labelName: ["Doing"] }],
      ["label_name[]=Doing&label_name[]=Bug", { labelName: ["Doing", "Bug"] }],
      ["assignee_username=alice", { assigneeUsername: "alice" }],
      ["assignee_username[]=alice", { assigneeUsername: "alice" }],
      ["assignee_username=None", { assigneeWildcardId: "NONE" }],
      ["assignee_username=Any", { assigneeWildcardId: "ANY" }],
      ["author_username=bob", { authorUsername: "bob" }],
      ["milestone_title=v1.0", { milestoneTitle: "v1.0" }],
      ["milestone_title=None", { milestoneWildcardId: "NONE" }],
      ["milestone_title=Upcoming", { milestoneWildcardId: "UPCOMING" }],
      ["milestone_title=%23started", { milestoneWildcardId: "STARTED" }],
      ["my_reaction_emoji=thumbsup", { myReactionEmoji: "thumbsup" }],
      ["release_tag=v2", { releaseTag: "v2" }],
      ["search=login%20bug", { search: "login bug" }],
      ["weight=3", { weight: "3" }],
      ["confidential=true", { confidential: true }],
      ["types[]=ISSUE&types[]=INCIDENT", { types: ["ISSUE", "INCIDENT"] }],
      ["iteration_id=12", { iterationId: "gid://gitlab/Iteration/12" }],
      ["not[label_name][]=Won't fix", { not: { labelName: ["Won't fix"] } }],
      ["not[assignee_username][]=alice", { not: { assigneeUsername: ["alice"] } }],
      ["not[author_username]=bob", { not: { authorUsername: "bob" } }],
      ["not[milestone_title]=v1.0", { not: { milestoneTitle: "v1.0" } }],
      ["not[my_reaction_emoji]=tada", { not: { myReactionEmoji: "tada" } }],
      ["not[release_tag]=v2", { not: { releaseTag: "v2" } }],
      ["not[types][]=INCIDENT", { not: { types: ["INCIDENT"] } }],
    ])("maps %s", (search, expected) => {
      expect(filtersFor(`?${search}`)).toEqual(expected);
    });

    it("maps a combination of filters, positive and negated", () => {
      expect(filtersFor("?label_name[]=Doing&assignee_username=alice&milestone_title=v1&not[label_name][]=Bug&search=x")).toEqual({
        labelName: ["Doing"],
        assigneeUsername: "alice",
        milestoneTitle: "v1",
        search: "x",
        not: { labelName: ["Bug"] },
      });
    });

    it("sends no filters when the URL has none", () => {
      expect(filtersFor("")).toBeUndefined();
    });

    it("ignores params that aren't filters", () => {
      expect(filtersFor("?utf8=%E2%9C%93&label_name[]=Doing&sort=created_date")).toEqual({ labelName: ["Doing"] });
      expect(filtersFor("?utf8=%E2%9C%93")).toBeUndefined();
    });

    it("drops all filters when any param is not recognised, to fetch a superset", () => {
      expect(filtersFor("?label_name[]=Doing&shiny_new_filter=1")).toBeUndefined();
      expect(filtersFor("?label_name[]=Doing&not[shiny_new_filter]=1")).toBeUndefined();
      expect(filtersFor("?label_name[]=Doing&milestone_title=a&milestone_title=b")).toBeUndefined();
    });

    it("maps filters on a group board", () => {
      expect(filtersFor("?label_name[]=Doing&author_username=bob", "https://gitlab.example/groups/group/-/boards/7")).toEqual({
        labelName: ["Doing"],
        authorUsername: "bob",
      });
    });

    it("applies the filters to the lists' cards and counts in the query", () => {
      const url = `${BASE}?label_name[]=Doing`;
      const { query } = buildFingerprintRequest(readBoardContext(url, page(url))!.board);
      expect(query).toMatch(/\$filters: BoardIssueInput/);
      expect(query).toMatch(/issues\(first: \$first, filters: \$filters\)/);
      expect(query).toMatch(/lists\(issueFilters: \$filters\)/);
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
        expect(compareWithProjectBoard(board)).toMatchObject({ kind: "remote", changedCount: 1 });
      });

      it("a card is removed from a list (closed elsewhere, moved off the board, deleted)", () => {
        const board = edited((lists) => {
          lists[0].issues.nodes.splice(1, 1);
          lists[0].issuesCount = 1;
        });
        expect(compareWithProjectBoard(board)).toMatchObject({ kind: "remote", changedCount: 1 });
      });

      it("a card moves to another list", () => {
        const board = edited((lists) => {
          const [moved] = lists[1].issues.nodes.splice(2, 1);
          lists[1].issuesCount = 2;
          lists[2].issues.nodes.push(moved);
          lists[2].issuesCount = 1;
        });
        expect(compareWithProjectBoard(board)).toMatchObject({ kind: "remote", changedCount: 1 });
      });

      it("cards are reordered within a list, with no timestamp touched", () => {
        const board = edited((lists) => lists[1].issues.nodes.reverse());
        // Issues 13 and 15 swap places; 14 stays in the middle.
        expect(compareWithProjectBoard(board)).toMatchObject({ kind: "remote", changedCount: 2 });
      });

      it("a card's fields are edited (its updatedAt moves on)", () => {
        const board = edited((lists) => (lists[0].issues.nodes[0].updatedAt = "2026-11-23T10:00:00Z"));
        expect(compareWithProjectBoard(board)).toMatchObject({ kind: "remote", changedCount: 1 });
      });

      it("several cards are edited, counting each card once", () => {
        const board = edited((lists) => {
          lists[0].issues.nodes[0].updatedAt = "2026-11-23T10:00:00Z";
          lists[1].issues.nodes[1].updatedAt = "2026-11-23T10:00:05Z";
          lists[3].issues.nodes[0].updatedAt = "2026-11-23T10:00:09Z";
        });
        expect(compareWithProjectBoard(board)).toMatchObject({ kind: "remote", changedCount: 3 });
      });

      it("a list is added", () => {
        const board = edited((lists) =>
          lists.splice(3, 0, {
            id: "gid://gitlab/List/5",
            title: "Blocked",
            listType: "label",
            position: 2,
            collapsed: false,
            label: { id: "gid://gitlab/ProjectLabel/23", title: "Blocked", color: "#dc143c" },
            issuesCount: 0,
            issues: { nodes: [] },
          }),
        );
        expect(compareWithProjectBoard(board)).toMatchObject({ kind: "remote", changedCount: 1 });
      });

      it("an empty list is removed", () => {
        const board = edited((lists) => lists.splice(2, 1));
        expect(compareWithProjectBoard(board)).toMatchObject({ kind: "remote", changedCount: 1 });
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
        expect(compareWithProjectBoard(renamed)).toMatchObject({ kind: "remote", changedCount: 1 });
        expect(compareWithProjectBoard(recoloured)).toMatchObject({ kind: "remote", changedCount: 1 });
      });

      it("a list's total count changes beyond the cards fetched", () => {
        const board = edited((lists) => (lists[1].issuesCount = 24));
        expect(compareWithProjectBoard(board)).toMatchObject({ kind: "remote", changedCount: 1 });
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
