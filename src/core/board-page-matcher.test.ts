import { readdirSync, readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { isBoardDocument, matchBoardPage } from "./board-page-matcher";

const configured = ["https://gitlab.com", "https://example.com"];

describe("Board Page Matcher", () => {
  it.each([
    ["project board", "https://gitlab.com/group/project/-/boards", "project-board"],
    ["group board", "https://gitlab.com/groups/my-group/-/boards", "group-board"],
    ["subgroup board", "https://gitlab.com/groups/my-group/sub/-/boards", "group-board"],
    ["project board with id", "https://gitlab.com/group/project/-/boards/42", "project-board"],
    ["group board with id", "https://gitlab.com/groups/my-group/-/boards/7/", "group-board"],
    ["board with filters", "https://gitlab.com/group/project/-/boards/42?label_name[]=bug#top", "project-board"],
    ["subpath project board", "https://example.com/gitlab/group/project/-/boards", "project-board"],
    ["subpath group board", "https://example.com/gitlab/groups/my-group/-/boards/3", "group-board"],
    ["sign-in page", "https://gitlab.com/users/sign_in", "sign-in"],
    ["subpath sign-in page", "https://example.com/gitlab/users/sign_in?redirect=1", "sign-in"],
    ["geo secondary sign-in page", "https://gitlab.com/users/auth/geo/sign_in", "sign-in"],
    ["issue list", "https://gitlab.com/group/project/-/issues", "none"],
    ["single issue", "https://gitlab.com/group/project/-/issues/12", "none"],
    ["merge request", "https://gitlab.com/group/project/-/merge_requests/3", "none"],
    ["epic board", "https://gitlab.com/groups/my-group/-/epic_boards/1", "none"],
    ["project named boards", "https://gitlab.com/group/boards", "none"],
    ["board sub-route", "https://gitlab.com/group/project/-/boards/42/edit", "none"],
    ["unconfigured origin board", "https://other.example.org/group/project/-/boards", "none"],
    ["unconfigured origin sign-in", "https://other.example.org/users/sign_in", "none"],
    ["configured host on another port", "https://gitlab.com:8443/group/project/-/boards", "none"],
    ["invalid url", "not a url", "none"],
  ])("%s: %s → %s", (_name, url, expected) => {
    expect(matchBoardPage(url, configured)).toBe(expected);
  });
});

describe("isBoardDocument", () => {
  const BOARD_URL = "https://gitlab.example/group/project/-/boards/1";
  const parse = (html: string) => new JSDOM(html, { url: BOARD_URL }).window.document;
  const FIXTURES = new URL("./fixtures/gitlab-19.5/", import.meta.url);

  it.each(readdirSync(FIXTURES).filter((name) => name.endsWith(".html")))("recognises the 19.5 snapshot %s", (name) => {
    expect(isBoardDocument(parse(readFileSync(new URL(name, FIXTURES), "utf8")))).toBe(true);
  });

  it("recognises a group board by its page id", () => {
    expect(isBoardDocument(parse('<body data-page="groups:boards:index"></body>'))).toBe(true);
  });

  it("rejects an error page served at a board URL", () => {
    expect(isBoardDocument(parse("<body><h1>502</h1><p>Whoops, GitLab is taking too much time to respond.</p></body>"))).toBe(
      false,
    );
  });

  it("rejects another GitLab page", () => {
    expect(isBoardDocument(parse('<body data-page="projects:issues:index"></body>'))).toBe(false);
  });
});
