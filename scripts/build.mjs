// Builds the extension into dist/, loadable via chrome://extensions → "Load unpacked".
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const outdir = "dist";

/** Bundled entry points → output file name (without .js). */
const entryPoints = {
  background: "src/background/service-worker.ts",
  "content-script": "src/content/content-script.ts",
  options: "src/options/options.ts",
  popup: "src/popup/popup.ts",
};

/** Static files copied as-is: source → destination in dist/. */
const staticFiles = {
  "src/manifest.json": "manifest.json",
  "src/options/options.html": "options.html",
  "src/options/options.css": "options.css",
  "src/popup/popup.html": "popup.html",
  "src/popup/popup.css": "popup.css",
};

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await build({
  entryPoints,
  outdir,
  bundle: true,
  format: "iife",
  target: "chrome102",
  sourcemap: true,
  logLevel: "info",
});

for (const [from, to] of Object.entries(staticFiles)) {
  await cp(from, `${outdir}/${to}`);
}
