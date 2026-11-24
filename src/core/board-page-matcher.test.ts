import { describe, expect, it } from "vitest";
import { matchBoardPage } from "./board-page-matcher";

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
