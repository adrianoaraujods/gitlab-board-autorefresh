/**
 * Blocker Detector (spec #1, ticket #4): `(document) → set of active blocker
 * reasons`. A reason is active when any of its selectors matches, primary
 * first, then fallbacks taken from GitLab's public source (19.5 markup).
 */

/** Why a reload must wait: something the user is in the middle of. */
export type BlockerReason = "sidebar-open" | "unsaved-input" | "overlay-open" | "dragging";

/** A check for one reason: true when it is active in `document`. */
type Check = (document: Document) => boolean;

const anyOf =
  (...selectors: string[]): Check =>
  (document) =>
    selectors.some((selector) => document.querySelector(selector) !== null);

/**
 * The work-item drawer is mounted (`v-if`) into `#contextual-panel-portal`
 * only while open. That portal also hosts other panels (Duo chat), so never
 * match `.contextual-panel` outside it.
 */
const sidebarDomOpen: Check = anyOf(
  '[data-testid="work-item-detail-panel"]',
  "#contextual-panel-portal .work-item-detail-panel",
  "#contextual-panel-portal .contextual-panel",
  "li.board-card.is-active",
);

/** Opening the drawer adds `?show=<item>` to the URL; closing it removes it. */
const sidebarInUrl: Check = (document) => new URL(document.URL).searchParams.has("show");

const sidebarOpen: Check = (document) => sidebarDomOpen(document) || sidebarInUrl(document);

/**
 * Modals, open dropdowns and in-board forms. Dropdown panels may be portalled
 * to `<body>`, so nothing here is scoped to the board root.
 */
const overlayOpen: Check = anyOf(
  // GlModal (bootstrap-vue modal manager)
  "body.modal-open",
  'body[data-modal-open-count]:not([data-modal-open-count="0"])',
  '.modal.show[aria-modal="true"]',
  ".gl-modal.show",
  ".modal-backdrop",
  // GlDisclosureDropdown / GlCollapsibleListbox (base_dropdown.vue)
  '.gl-new-dropdown-toggle[aria-expanded="true"]',
  '[data-testid="base-dropdown-toggle"][aria-expanded="true"]',
  '.gl-new-dropdown-custom-toggle[aria-expanded="true"]',
  '.gl-new-dropdown-custom-toggle [aria-expanded="true"]',
  ".gl-new-dropdown-panel.\\!gl-block",
  // Filtered search bar suggestions
  ".gl-filtered-search-suggestion-list",
  ".gl-filtered-search-token-segment-active",
  // New-issue form in a list: open/closed state, not unsaved text
  ".board-new-issue-form",
  '.board-list-component form [data-testid="create-button"]',
  // List settings drawer
  "aside.gl-drawer.js-board-settings-sidebar",
  "#js-right-sidebar-portal aside.gl-drawer",
  "aside.gl-drawer.boards-sidebar",
  // Add-list form
  '[data-testid="board-add-new-column"]',
  '[data-testid="board-add-column-form-title"]',
  // Last resort: any modal dialog
  '[role="dialog"][aria-modal="true"]',
);

/**
 * SortableJS ghost and chosen classes for card and column drags. Never the
 * `body.is-dragging` class on its own: a drag cancelled with Esc leaves it
 * behind until the next successful drag (board_list.vue `handleDragOnEnd`).
 */
const dragging: Check = anyOf(".board-card-drag-active", ".sortable-chosen", ".sortable-drag", ".is-ghost");

/**
 * Fields whose value is driven by script rather than by the user's typing, so
 * `defaultValue` says nothing about unsaved work: GlFilteredSearch binds its
 * inputs through Vue, and dropdown search boxes are covered by `overlay-open`.
 */
const NOT_USER_TEXT = '[class*="gl-filtered-search-"], .gl-new-dropdown-panel';

/** Inputs that hold no typed text. */
const NON_TEXT_INPUT_TYPES = new Set(["hidden", "checkbox", "radio", "submit", "button", "reset", "image", "file", "range", "color"]);

/** A contenteditable host (tiptap/ProseMirror for GitLab's rich-text editor). */
const EDITABLE_HOST = '[contenteditable]:not([contenteditable="false"])';

function isTextField(element: Element): element is HTMLInputElement | HTMLTextAreaElement {
  if (element.tagName === "TEXTAREA") return true;
  return element.tagName === "INPUT" && !NON_TEXT_INPUT_TYPES.has((element as HTMLInputElement).type);
}

/**
 * Focus resting in an editable field means the user was typing there when
 * they left the window, even if nothing is typed yet. GitLab's own drawer
 * refuses to close in the same situation.
 */
function focusInEditable(document: Document): boolean {
  const focused = document.activeElement;
  if (!focused || focused.closest(NOT_USER_TEXT)) return false;
  return isTextField(focused) || focused.closest(EDITABLE_HOST) !== null;
}

/**
 * Generic check: focus in an editable field, a textarea or text input whose value differs from its
 * initial value, or a contenteditable with text in it. An empty ProseMirror
 * doc still holds `<p><br></p>`, hence the text check rather than markup.
 */
const unsavedInput: Check = (document) => {
  if (focusInEditable(document)) return true;
  const fields = [...document.querySelectorAll("textarea, input")].filter(
    (field) => isTextField(field) && !field.closest(NOT_USER_TEXT),
  ) as Array<HTMLInputElement | HTMLTextAreaElement>;
  if (fields.some((field) => field.value !== field.defaultValue)) return true;
  return [...document.querySelectorAll(EDITABLE_HOST)].some(
    (host) => !host.closest(NOT_USER_TEXT) && (host.textContent ?? "").trim() !== "",
  );
};

const CHECKS: ReadonlyArray<[BlockerReason, Check]> = [
  ["sidebar-open", sidebarOpen],
  ["unsaved-input", unsavedInput],
  ["overlay-open", overlayOpen],
  ["dragging", dragging],
];

/** The blocker reasons active in `document` right now; empty when a reload is safe. */
export function detectBlockers(document: Document): Set<BlockerReason> {
  return new Set(CHECKS.filter(([, check]) => check(document)).map(([reason]) => reason));
}
