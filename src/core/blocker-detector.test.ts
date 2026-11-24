import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { detectBlockers } from "./blocker-detector";

/** Board URL used for every snapshot; scrubbed of any real instance. */
const BOARD_URL = "https://gitlab.example/group/project/-/boards/1";

/** Parses a saved GitLab 19.5 board snapshot from `fixtures/gitlab-19.5/`. */
function snapshot(name: string, url = BOARD_URL): Document {
  const html = readFileSync(new URL(`./fixtures/gitlab-19.5/${name}.html`, import.meta.url), "utf8");
  return new JSDOM(html, { url }).window.document;
}

/** A minimal synthetic page for the generic editable/unsaved checks. */
function page(bodyHtml: string): Document {
  return new JSDOM(`<!doctype html><body>${bodyHtml}</body>`, { url: BOARD_URL }).window.document;
}

describe("Blocker Detector", () => {
  describe("on GitLab 19.5 board snapshots", () => {
    it("finds nothing on a plain board", () => {
      expect(detectBlockers(snapshot("board-plain"))).toEqual(new Set());
    });

    it("finds the issue sidebar open", () => {
      expect(detectBlockers(snapshot("sidebar-open", `${BOARD_URL}?show=eyJpaWQiOiIxIn0%3D`))).toEqual(
        new Set(["sidebar-open"]),
      );
    });
  });

  describe("on GitLab 19.5 overlays", () => {
    it("finds the label dropdown open", () => {
      expect(detectBlockers(snapshot("label-dropdown-open"))).toEqual(new Set(["overlay-open"]));
    });

    it("finds the new-issue form open in a list, even with an empty title", () => {
      expect(detectBlockers(snapshot("new-issue-form"))).toEqual(new Set(["overlay-open"]));
    });

    it("finds the new-issue form with a title typed as unsaved too", () => {
      const document = snapshot("new-issue-form");
      document.querySelector<HTMLInputElement>('input[name="issue_title"]')!.value = "New issue";
      expect(detectBlockers(document)).toEqual(new Set(["overlay-open", "unsaved-input"]));
    });

    it("finds the board modal open", () => {
      expect(detectBlockers(snapshot("board-modal-open"))).toEqual(new Set(["overlay-open"]));
    });

    it("finds the list settings drawer open", () => {
      expect(detectBlockers(snapshot("list-settings-open"))).toEqual(new Set(["overlay-open"]));
    });
  });

  describe("on GitLab 19.5 card drags", () => {
    it("finds a card drag in progress", () => {
      expect(detectBlockers(snapshot("drag-in-progress"))).toEqual(new Set(["dragging"]));
    });

    it("ignores a body drag class left behind by a drag cancelled with Esc", () => {
      expect(detectBlockers(snapshot("drag-cancelled-stale-body-class"))).toEqual(new Set());
    });
  });

  describe("on GitLab 19.5 comment editors", () => {
    it("finds a half-written markdown comment in the sidebar", () => {
      const document = snapshot("comment-draft-markdown");
      document.querySelector("textarea")!.value = "half-written comment";
      expect(detectBlockers(document)).toEqual(new Set(["sidebar-open", "unsaved-input"]));
    });

    it("finds a half-written rich-text comment in the sidebar", () => {
      expect(detectBlockers(snapshot("comment-draft-rich-text"))).toEqual(new Set(["sidebar-open", "unsaved-input"]));
    });

    it("does not count an empty comment editor as unsaved", () => {
      expect(detectBlockers(snapshot("comment-draft-markdown"))).toEqual(new Set(["sidebar-open"]));
      expect(detectBlockers(snapshot("comment-editor-empty-rich-text"))).toEqual(new Set(["sidebar-open"]));
    });
  });

  describe("on minimal documents", () => {
    it("finds a textarea whose value differs from its initial value", () => {
      const document = page("<textarea>original</textarea>");
      expect(detectBlockers(document)).toEqual(new Set());
      document.querySelector("textarea")!.value = "original, edited";
      expect(detectBlockers(document)).toEqual(new Set(["unsaved-input"]));
    });

    it("finds a text input whose value differs from its initial value", () => {
      const document = page('<input type="text" value="Title">');
      expect(detectBlockers(document)).toEqual(new Set());
      document.querySelector("input")!.value = "Title, edited";
      expect(detectBlockers(document)).toEqual(new Set(["unsaved-input"]));
    });

    it("finds a contenteditable with text in it", () => {
      expect(detectBlockers(page('<div contenteditable="true"><p>draft</p></div>'))).toEqual(new Set(["unsaved-input"]));
      expect(detectBlockers(page('<div contenteditable=""><p> </p></div>'))).toEqual(new Set());
      expect(detectBlockers(page('<div contenteditable="false"><p>read-only</p></div>'))).toEqual(new Set());
    });

    it("ignores inputs that hold no typed text", () => {
      const document = page('<input type="checkbox"><input type="hidden" value="a">');
      document.querySelector<HTMLInputElement>('[type="hidden"]')!.value = "b";
      document.querySelector<HTMLInputElement>('[type="checkbox"]')!.checked = true;
      expect(detectBlockers(document)).toEqual(new Set());
    });

    it("ignores the filtered search bar, whose value is set by script", () => {
      const document = page('<input class="gl-filtered-search-term-input">');
      document.querySelector("input")!.value = "label:bug";
      expect(detectBlockers(document)).toEqual(new Set());
    });

    it("finds focus resting in an editable field, even an empty one", () => {
      const document = page('<textarea></textarea><input type="text"><div contenteditable="true"></div>');
      for (const selector of ["textarea", "input", "[contenteditable]"]) {
        document.querySelector<HTMLElement>(selector)!.focus();
        expect(detectBlockers(document), selector).toEqual(new Set(["unsaved-input"]));
      }
    });

    it("ignores focus on something that is not editable", () => {
      const document = page('<button>Go</button><input type="checkbox">');
      document.querySelector("button")!.focus();
      expect(detectBlockers(document)).toEqual(new Set());
      document.querySelector<HTMLElement>("input")!.focus();
      expect(detectBlockers(document)).toEqual(new Set());
    });

    it("treats a board URL that names an open work item (?show=) as the sidebar being open", () => {
      const document = new JSDOM("<!doctype html><body></body>", { url: `${BOARD_URL}?show=abc` }).window.document;
      expect(detectBlockers(document)).toEqual(new Set(["sidebar-open"]));
    });
  });
});
