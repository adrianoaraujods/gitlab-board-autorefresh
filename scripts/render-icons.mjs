// Renders the icon SVGs in assets/ to the PNGs the manifest and the Web Store need.
// Needs `rsvg-convert` (librsvg) on PATH. The PNGs are committed, so only run this after
// changing an SVG: `npm run icons`.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

mkdirSync("src/icons", { recursive: true });

function render(svg, out, size, { padding = 0 } = {}) {
  const art = size - 2 * padding;
  const args = ["--width", `${art}`, "--height", `${art}`, "--output", out];
  if (padding > 0) {
    args.push("--page-width", `${size}`, "--page-height", `${size}`, "--left", `${padding}`, "--top", `${padding}`);
  }
  execFileSync("rsvg-convert", [...args, svg]);
  console.log(`${out} (${size}×${size})`);
}

// Manifest "icons": extensions page, install dialog, store fallback.
for (const size of [16, 32, 48, 128]) render("assets/icon.svg", `src/icons/icon-${size}.png`, size);
// Toolbar ("action.default_icon"): no refresh arc, so the bottom-right corner stays clear for the status badge.
for (const size of [16, 32]) render("assets/icon-toolbar.svg", `src/icons/toolbar-${size}.png`, size);
// Web Store icon: 128×128 with 96×96 artwork and 16 px transparent padding per side.
render("assets/icon.svg", "store/icon-128.png", 128, { padding: 16 });
