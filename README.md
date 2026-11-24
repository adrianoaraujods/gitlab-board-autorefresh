# Board Auto-Refresh for GitLab

A Chromium (Manifest V3) extension that reloads GitLab issue boards while their window is unfocused,
so a board left open on a second monitor stays current, and never reloads while you are using it or
editing something on it.

This is an independent open-source project. It is not an official GitLab product and is not endorsed by
GitLab Inc.

## What it does

- **Focused window: no reloads.** The board only refreshes once you click into another window or app. Opening the
  extension's popup or clicking the address bar doesn't count as leaving the window.
- **Unfocused: reloads every interval** (30 seconds by default). If the board hasn't been reloaded for longer
  than the interval, it reloads as soon as you click away; otherwise it waits out the rest of the interval.
- **Never interrupts editing.** A reload is skipped while the issue sidebar is open, a text field has unsaved
  content, a modal or dropdown is open, or a card is being dragged. It retries on the next interval.
- **Keeps your place.** Filters in the board URL are kept, and the page scroll and each list's scroll are restored.
- **Backs off on errors.** Failed reloads retry with exponential backoff up to 5 minutes. If a reload lands on the
  sign-in page, auto-refresh stops until you sign in again.
- Works on gitlab.com and self-hosted instances (including GitLab under a subpath), for project and group boards.
  Other GitLab pages (issues, merge requests…) are left alone.

### Toolbar badge

| Badge | Meaning |
| --- | --- |
| Green | Auto-refresh active: the window is unfocused and the board reloads every interval |
| Grey | Idle: the window is focused, the tab is paused, or (in "Current tab" mode) it is not the visible tab |
| None | Not a board page |
| Yellow | A reload was skipped because you are editing |
| Red | Signed out, or reloads are failing |

Click the toolbar icon for this tab's status, a **Pause this tab** toggle (lasts until the tab is closed) and a link
to the options.

## Install

- **Chrome Web Store:** search for "Board Auto-Refresh for GitLab".
- **Unpacked (any Chromium browser):** build it (see [Development](#development)), open `chrome://extensions`,
  turn on **Developer mode**, click **Load unpacked** and pick the `dist/` folder.

## Configure

Open the extension's options (from the popup, or **Details → Extension options** on `chrome://extensions`).

- **Domains.** `https://gitlab.com` is pre-filled. To use a self-hosted instance, add its origin, for example
  `https://gitlab.example.com` or `https://gitlab.example.com:8443` (scheme, host and optional port; no path, even if
  GitLab is served under a subpath). Each domain needs one **Grant** click, which asks Chrome for access to that
  origin only. Removing a domain gives the access back.
- **Which tabs refresh.**
  - **Current tab** (default): only the visible, active board tab in each window.
  - **All tabs**: background and hidden board tabs refresh too.
- **Refresh interval:** seconds between reloads, minimum 10.

Settings sync across your Chrome profiles through Chrome sync.

## Privacy and permissions

No data is collected or sent anywhere; see [PRIVACY.md](PRIVACY.md). The extension declares no host access up front:
every GitLab origin is an optional permission you grant from the options page.

| Permission | Why |
| --- | --- |
| `storage` | Settings (`chrome.storage.sync`) and per-tab pause state (`chrome.storage.session`) |
| `scripting` | Registers the content script only on the origins you granted |
| Optional `https://*/*`, `http://*/*` | Lets you grant your own GitLab origin; requested per origin, on click |

## Known limitations

- Focus comes from both the page (DOM focus) and Chrome's focused-window tracking. On Linux under Wayland, how Chrome
  reports window focus depends on the compositor, so check by hand that the board stays idle while focused and
  starts refreshing once you switch to another app.

## Development

Requires Node.js and npm.

```sh
npm ci
npm test           # Vitest unit tests
npm run typecheck  # TypeScript, no emit
npm run build      # bundles into dist/ (load it unpacked, see Install)
npm run package    # clean build + Web Store zip: gitlab-board-autorefresh-<version>.zip
npm run icons      # re-renders the PNG icons from assets/*.svg (needs rsvg-convert)
```

After loading `dist/` unpacked, open the options, click **Grant** next to a domain, then open an issue board on it:
the badge is grey while the board's window is focused and green while it is unfocused.

### Tests

Unit tests live next to the code (`*.test.ts`) and cover the pure modules: the Refresh Scheduler (timing and policy
rules, fed event sequences with explicit timestamps), the Blocker Detector (against saved, scrubbed HTML snapshots of
GitLab 19.5 boards in `src/core/fixtures/`), the Board Page Matcher, domain and interval validation, and the Scroll
Snapshot. `scripts/lib/*.test.ts` checks the packaging file list and that the store listing justifies exactly the
manifest's permissions.

The content script adapter, background worker, options page and popup are checked by hand against a real GitLab
instance.

When GitLab changes its board markup, save a snapshot of the new markup as a fixture (remove any instance domains,
names and data first), add a failing test, and update the selectors in `src/core/blocker-detector.ts`.

### Releasing to the Chrome Web Store

1. Bump `version` in `src/manifest.json` (and `package.json`).
2. `npm run package` and upload the zip.
3. Copy the listing and privacy answers from [`store/listing.md`](store/listing.md); the store icon is `store/icon-128.png`.

### Layout

| Path | Module |
| --- | --- |
| `src/core/` | Pure, browser-free modules with unit tests |
| `src/core/refresh-scheduler.ts` | Refresh Scheduler: pure `(state, event, now) → { state, commands }` transition |
| `src/core/blocker-detector.ts` | Blocker Detector: `(document) → active blocker reasons` |
| `src/core/board-page-matcher.ts` | Board Page Matcher |
| `src/core/scroll-snapshot.ts` | Scroll Snapshot |
| `src/core/domain-origin.ts` | Domain validation (origin only) and match patterns |
| `src/core/refresh-interval.ts` | Refresh interval validation (default 30s, minimum 10s) |
| `src/core/badge.ts` | Badge states |
| `src/shared/` | Browser helpers used by several entry points: settings and messages |
| `src/background/` | Background Service Worker: badge per tab, tab activity, pause state, content-script registration |
| `src/content/content-script.ts` | Content Script Adapter |
| `src/options/`, `src/popup/` | Options Page and Popup |
| `src/icons/` | Rendered PNG icons (generated from `assets/`) |
| `src/manifest.json` | Manifest; no host permissions, every origin is optional and granted at runtime |
| `scripts/build.mjs` | esbuild bundling and static-file copying into `dist/` |
| `scripts/package.mjs` | Store zip from a clean build |
| `store/` | Web Store listing text, privacy answers and store icon |

## Contributing

Issues and pull requests are welcome. Please add or update tests for changes to the core modules, run `npm test` and
`npm run typecheck`, and never commit a real self-hosted GitLab domain or data from a private instance (in code,
fixtures, screenshots or docs).

## License

[MIT](LICENSE)
