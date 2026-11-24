/**
 * Content Script Adapter. Injected on every page of a granted origin; does
 * nothing unless the page is an issue board. Later tickets wire focus, blur,
 * visibility and timers into the Refresh Scheduler here (#3) and carry out
 * its commands.
 */
import { isBoardPage, matchBoardPage } from "../core/board-page-matcher";
import { sendToBackground } from "../shared/messages";
import { loadSettings } from "../shared/settings";

async function main(): Promise<void> {
  const { domains } = await loadSettings();
  const kind = matchBoardPage(location.href, domains);
  await sendToBackground({ type: "set-badge", badge: isBoardPage(kind) ? "idle" : null });
}

void main();
