# Chrome Web Store listing

Copy these fields into the Chrome Web Store developer dashboard. `scripts/lib/store-listing.test.ts`
checks that this file matches `src/manifest.json`, so update both together.

## Store listing tab

Name: Board Auto-Refresh for GitLab

Summary (from the manifest `description`, 132 characters max):

> Auto-refreshes issue boards for GitLab while their window is unfocused. Not an official GitLab product.

Category: Workflow & Planning

Language: English

### Description

Board Auto-Refresh for GitLab keeps a GitLab issue board current on a second monitor, without
ever reloading it while you are using it.

This is an independent, open-source extension. It is not made, endorsed or supported by GitLab Inc.
"GitLab" is a trademark of GitLab Inc., used here only to say which product the extension works with.

How it works:

- While the board's window has focus, the board is never reloaded.
- When you click away (into another window or app), the board reloads every refresh interval
  (30 seconds by default, minimum 10) until you come back.
- A reload is skipped while you are in the middle of something: the issue sidebar is open, a comment,
  title or description has unsaved text, a modal or dropdown is open, or a card is being dragged.
  It tries again on the next interval.
- After a reload, the page scroll and each list column's scroll are restored.
- Filters and search parameters in the board URL are kept.
- Works with gitlab.com and self-hosted GitLab instances, including instances under a subpath.
  Project boards and group boards are both supported.

The toolbar badge shows the state at a glance:

- Green: auto-refresh is active (window unfocused).
- Grey: idle (window focused, or the tab is paused). Pages that are not boards get no badge.
- Yellow: a reload was skipped because you are editing.
- Red: you were signed out, or reloads are failing (retried with backoff up to 5 minutes).

Click the toolbar icon for the current tab's status, a "Pause this tab" toggle and a link to the options.

Options:

- GitLab domains: gitlab.com is pre-filled. Add your own instance's origin, for example
  `https://gitlab.example.com`. Each domain needs one "Grant" click, and the extension can only run on
  domains you have granted. Removing a domain gives its access back.
- Which tabs refresh: "Current tab" (default) refreshes only the visible board tab in each window;
  "All tabs" also refreshes background board tabs.
- Refresh interval in seconds.

Privacy: no data is collected or sent anywhere. Settings are stored with Chrome's sync storage.

Source code (MIT): https://github.com/adrianoaraujods/gitlab-board-autorefresh

### Graphics

- Store icon: `store/icon-128.png` (128×128, 96×96 artwork with 16 px transparent padding).
- Screenshots: at least one 1280×800 screenshot of a board with the green badge and the popup open.
  Take it on gitlab.com or a scrubbed test instance; it must not show any private instance's domain or data.
- Small promo tile (440×280): optional.

## Privacy practices tab

### Single purpose

Automatically reloads GitLab issue boards while their window is unfocused, so a board left open stays
up to date, and skips reloads while the user is editing on the board.

## Permission justifications

### `storage`

Stores the user's settings (the list of GitLab domains, the refresh mode and the refresh interval) in
`chrome.storage.sync`, and the per-tab "Pause this tab" state in `chrome.storage.session` for the life of
the tab. Nothing else is stored.

### `scripting`

Registers the extension's content script dynamically, only on the GitLab origins the user has added and
granted on the options page, and unregisters it when the user removes a domain or revokes access. No code
is injected anywhere else, and all code ships in the package.

### `https://*/*`

Declared only as an optional host permission; no host access is granted at install. Users run GitLab on
their own domains, so the exact origins cannot be listed in advance. Each origin is requested individually
(for example `https://gitlab.com/*`) when the user clicks "Grant" on the options page, and given back when
the domain is removed. On a granted origin the content script only acts on issue board pages.

### `http://*/*`

Same as `https://*/*`, for self-hosted GitLab instances served over plain HTTP on an internal network.
Requested per origin, only after the user adds that origin and clicks "Grant".

### Remote code

No. All JavaScript is bundled in the package; the extension loads no remote code.

### Data usage

Tick nothing: the extension does not collect or transmit any user data. Its only network requests are
reloads of the board page the user already has open (plus a same-origin `HEAD` request to that page
first, to check the server is reachable), made with the user's existing GitLab session.

Certify the three Limited Use disclosures.

Privacy policy URL: https://github.com/adrianoaraujods/gitlab-board-autorefresh/blob/main/PRIVACY.md
