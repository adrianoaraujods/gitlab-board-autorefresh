# Privacy policy

Board Auto-Refresh for GitLab does not collect, store remotely, sell or share any personal or
browsing data. It has no analytics, no tracking and no servers of its own.

## What the extension stores

- **Settings** (the GitLab domains you added, the refresh mode, the refresh interval, the detection mode, and the own-edits, safety-net and update-in-place options) in Chrome's
  sync storage, so they follow your Chrome profile. Chrome syncs them; the extension never sees them
  leave your browser.
- **Per-tab "Pause this tab" state** in Chrome's session storage, cleared when the tab closes or the
  browser restarts.
- **Scroll positions, the last reload time and the board's change-detection fingerprint** (list and
  card ids, card order, last-changed times and the id of the user who last changed each card) of a board tab in that page's own session storage, so
  the board looks the same after a reload and only reloads when it changed.

## Which sites it can access

None until you grant one. Each GitLab origin you add on the options page needs an explicit "Grant"
click, and removing it gives the access back. On granted origins the extension only acts on issue
board pages.

## Network requests

The only requests the extension causes are a small GraphQL request each interval to check whether the
board you have open changed (to that instance's `/api/graphql`), reloads of that board page, and a
`HEAD` request to that same page just before a reload, to check the server is reachable. They go to
your own GitLab instance with your existing session, as the board page's own requests do. No new data leaves your
browser: the experimental "Update in place" option uses `chrome.scripting` inside the board page to ask the page's
own data layer to refetch the board from your GitLab instance, and nothing else.

## Contact

Open an issue at https://github.com/adrianoaraujods/gitlab-board-autorefresh/issues.
