# Privacy policy

Board Auto-Refresh for GitLab does not collect, store remotely, sell or share any personal or
browsing data. It has no analytics, no tracking and no servers of its own.

## What the extension stores

- **Settings** (the GitLab domains you added, the refresh mode and the refresh interval) in Chrome's
  sync storage, so they follow your Chrome profile. Chrome syncs them; the extension never sees them
  leave your browser.
- **Per-tab "Pause this tab" state** in Chrome's session storage, cleared when the tab closes or the
  browser restarts.
- **Scroll positions and the last reload time** of a board tab in that page's own session storage,
  so the board looks the same after a reload.

## Which sites it can access

None until you grant one. Each GitLab origin you add on the options page needs an explicit "Grant"
click, and removing it gives the access back. On granted origins the extension only acts on issue
board pages.

## Network requests

The only requests the extension causes are reloads of the board page you already have open, plus a
`HEAD` request to that same page just before, to check the server is reachable. They go to your own
GitLab instance with your existing session, as a manual reload would.

## Contact

Open an issue at https://github.com/adrianoaraujods/gitlab-board-autorefresh/issues.
