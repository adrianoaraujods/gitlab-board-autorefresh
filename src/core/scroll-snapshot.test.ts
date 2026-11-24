// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { restoreScrollSnapshot, saveScrollSnapshot } from "./scroll-snapshot";

const BOARD_URL = "https://gitlab.com/group/project/-/boards/42";
const T0 = 1_000_000;

/**
 * jsdom has no layout, so scrollTop is always 0. Give an element a fake
 * scroll range that clamps like a browser does: `maxScroll` is
 * scrollHeight − clientHeight, and it grows as cards are appended.
 */
function makeScrollable(el: Element, maxScroll: () => number): void {
  let top = 0;
  let left = 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => (top = Math.max(0, Math.min(v, maxScroll()))),
  });
  Object.defineProperty(el, "scrollLeft", {
    configurable: true,
    get: () => left,
    set: (v: number) => (left = Math.max(0, v)),
  });
}

const CARD_HEIGHT = 100;
const LIST_HEIGHT = 300;

function boardShell(): void {
  document.body.innerHTML = `
    <div class="panel-content-inner js-static-panel-inner">
      <div class="boards-list"></div>
    </div>`;
  makeScrollable(panel(), () => 1000);
}

function panel(): HTMLElement {
  return document.querySelector<HTMLElement>(".js-static-panel-inner")!;
}

/** Adds a list column with `cards` cards; its scroll range follows its card count. */
function addList(id: string, cards: number): HTMLElement {
  const ul = document.createElement("ul");
  ul.className = "board-list";
  ul.dataset.board = id;
  makeScrollable(ul, () => Math.max(0, ul.children.length * CARD_HEIGHT - LIST_HEIGHT));
  addCards(ul, cards);
  document.querySelector(".boards-list")!.append(ul);
  return ul;
}

function addCards(ul: Element, count: number): void {
  for (let i = 0; i < count; i++) {
    const li = document.createElement("li");
    li.className = "board-card";
    ul.append(li);
  }
}

function list(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(`ul.board-list[data-board="${id}"]`)!;
}

/** Simulates `location.reload()`: the DOM is rebuilt, sessionStorage survives. */
function reloadPage(): void {
  boardShell();
}

const options = (now: number) => ({ url: BOARD_URL, now, timeoutMs: 200 });

describe("Scroll Snapshot", () => {
  beforeEach(() => {
    sessionStorage.clear();
    boardShell();
  });

  it("restores the page scroll and each list's scroll after a reload", async () => {
    addList("gid://gitlab/List/1", 10).scrollTop = 250;
    addList("gid://gitlab/List/2", 10).scrollTop = 400;
    panel().scrollTop = 120;
    saveScrollSnapshot(document, sessionStorage, { url: BOARD_URL, now: T0 });

    reloadPage();
    addList("gid://gitlab/List/1", 10);
    addList("gid://gitlab/List/2", 10);
    const outcome = await restoreScrollSnapshot(document, sessionStorage, options(T0 + 500));

    expect(outcome).toBe("restored");
    expect(panel().scrollTop).toBe(120);
    expect(list("gid://gitlab/List/1").scrollTop).toBe(250);
    expect(list("gid://gitlab/List/2").scrollTop).toBe(400);
  });

  it("waits for lists that render after the page loads", async () => {
    addList("gid://gitlab/List/1", 10).scrollTop = 250;
    saveScrollSnapshot(document, sessionStorage, { url: BOARD_URL, now: T0 });

    reloadPage();
    const restoring = restoreScrollSnapshot(document, sessionStorage, options(T0 + 500));
    await tick();
    addList("gid://gitlab/List/1", 10);

    expect(await restoring).toBe("restored");
    expect(list("gid://gitlab/List/1").scrollTop).toBe(250);
  });

  it("keeps scrolling a list as more cards page in until it reaches the saved position", async () => {
    addList("gid://gitlab/List/1", 20).scrollTop = 1500;
    saveScrollSnapshot(document, sessionStorage, { url: BOARD_URL, now: T0 });

    reloadPage();
    const ul = addList("gid://gitlab/List/1", 10);
    const restoring = restoreScrollSnapshot(document, sessionStorage, options(T0 + 500));
    await tick();
    expect(ul.scrollTop).toBe(700); // clamped: only 10 cards so far
    addCards(ul, 10);

    expect(await restoring).toBe("restored");
    expect(ul.scrollTop).toBe(1500);
  });

  it("gives up quietly after the timeout if the lists never render", async () => {
    addList("gid://gitlab/List/1", 10).scrollTop = 250;
    saveScrollSnapshot(document, sessionStorage, { url: BOARD_URL, now: T0 });

    reloadPage();
    const outcome = await restoreScrollSnapshot(document, sessionStorage, { ...options(T0 + 500), timeoutMs: 20 });

    expect(outcome).toBe("timed-out");
    addList("gid://gitlab/List/1", 10);
    await tick();
    expect(list("gid://gitlab/List/1").scrollTop).toBe(0);
  });

  it("keys snapshots by URL, so another board or filter doesn't pick them up", async () => {
    const filtered = `${BOARD_URL}?label_name[]=bug`;
    addList("gid://gitlab/List/1", 10).scrollTop = 250;
    saveScrollSnapshot(document, sessionStorage, { url: BOARD_URL, now: T0 });
    list("gid://gitlab/List/1").scrollTop = 100;
    saveScrollSnapshot(document, sessionStorage, { url: filtered, now: T0 });

    reloadPage();
    addList("gid://gitlab/List/1", 10);
    expect(await restoreScrollSnapshot(document, sessionStorage, { ...options(T0 + 500), url: filtered })).toBe(
      "restored",
    );
    expect(list("gid://gitlab/List/1").scrollTop).toBe(100);

    reloadPage();
    addList("gid://gitlab/List/1", 10);
    expect(
      await restoreScrollSnapshot(document, sessionStorage, {
        ...options(T0 + 500),
        url: "https://gitlab.com/group/project/-/boards/7",
      }),
    ).toBe("no-snapshot");
    expect(list("gid://gitlab/List/1").scrollTop).toBe(0);
  });

  it("uses a snapshot once, so a later manual reload starts at the top", async () => {
    addList("gid://gitlab/List/1", 10).scrollTop = 250;
    saveScrollSnapshot(document, sessionStorage, { url: BOARD_URL, now: T0 });
    reloadPage();
    addList("gid://gitlab/List/1", 10);
    await restoreScrollSnapshot(document, sessionStorage, options(T0 + 500));

    reloadPage(); // the user presses F5
    addList("gid://gitlab/List/1", 10);
    const outcome = await restoreScrollSnapshot(document, sessionStorage, options(T0 + 5_000));

    expect(outcome).toBe("no-snapshot");
    expect(list("gid://gitlab/List/1").scrollTop).toBe(0);
  });

  it("ignores a snapshot too old to come from the reload that just happened", async () => {
    addList("gid://gitlab/List/1", 10).scrollTop = 250;
    saveScrollSnapshot(document, sessionStorage, { url: BOARD_URL, now: T0 });

    reloadPage();
    addList("gid://gitlab/List/1", 10);
    const outcome = await restoreScrollSnapshot(document, sessionStorage, options(T0 + 10 * 60_000));

    expect(outcome).toBe("no-snapshot");
    expect(list("gid://gitlab/List/1").scrollTop).toBe(0);
  });

  it("falls back to the document scroller when the page has no static panel", async () => {
    document.body.innerHTML = "";
    const root = document.documentElement;
    makeScrollable(root, () => 1000);
    root.scrollTop = 300;
    saveScrollSnapshot(document, sessionStorage, { url: BOARD_URL, now: T0 });

    root.scrollTop = 0;
    expect(await restoreScrollSnapshot(document, sessionStorage, options(T0 + 500))).toBe("restored");
    expect(root.scrollTop).toBe(300);
  });

  it("treats unreadable stored data as no snapshot", async () => {
    sessionStorage.setItem(`gitlab-board-autorefresh:scroll:${BOARD_URL}`, "{not json");
    expect(await restoreScrollSnapshot(document, sessionStorage, options(T0))).toBe("no-snapshot");
  });
});

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
