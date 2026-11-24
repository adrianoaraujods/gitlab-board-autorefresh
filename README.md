# Board Auto-Refresh for GitLab

A Chromium (Manifest V3) extension that reloads GitLab issue boards while their window is unfocused.
Not an official GitLab product.

## Development

```sh
npm install
npm test           # Vitest unit tests
npm run typecheck  # TypeScript, no emit
npm run build      # bundles into dist/
```

Load `dist/` via `chrome://extensions` → Developer mode → **Load unpacked**. Open the extension's
options, click **Grant** next to a domain, then open an issue board on it: the toolbar badge is grey (idle) while the board's window is
focused, and green (polling) while it is unfocused, reloading every interval.

## Layout

| Path | Module |
| --- | --- |
| `src/core/` | Pure, browser-free modules with unit tests (`*.test.ts` next to the code) |
| `src/core/board-page-matcher.ts` | Board Page Matcher |
| `src/core/domain-origin.ts` | Domain validation (origin only) and match patterns |
| `src/core/refresh-scheduler.ts` | Refresh Scheduler: pure `(state, event, now) → { state, commands }` transition |
| `src/core/refresh-interval.ts` | Refresh interval validation (default 30s, minimum 10s) |
| `src/core/badge.ts` | Badge states |
| `src/shared/` | Browser helpers used by several entry points: settings (`chrome.storage.sync`) and messages |
| `src/background/` | Background Service Worker: badge per tab, dynamic content-script registration |
| `src/content/content-script.ts` | Content Script Adapter |
| `src/options/` | Options Page |
| `src/manifest.json` | Manifest; no host permissions, every origin is optional and granted at runtime |
| `scripts/build.mjs` | esbuild bundling and static-file copying into `dist/` |

## License

MIT
