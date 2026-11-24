// Builds the extension from clean and zips dist/ into the file to upload to the Chrome Web Store:
// manifest.json at the zip root, no source maps. Needs `zip` on PATH.
// Output: gitlab-board-autorefresh-<manifest version>.zip in the repo root.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { missingManifestFiles, packageFiles } from "./lib/package-contents.mjs";

execFileSync(process.execPath, ["scripts/build.mjs"], { stdio: "inherit" });

const distFiles = readdirSync("dist", { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => resolve(entry.parentPath, entry.name).slice(resolve("dist").length + 1).split("\\").join("/"));
const files = packageFiles(distFiles);

const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
const missing = missingManifestFiles(manifest, files);
if (missing.length > 0) {
  throw new Error(`manifest.json references files missing from the build: ${missing.join(", ")}`);
}

const zipPath = resolve(`gitlab-board-autorefresh-${manifest.version}.zip`);
rmSync(zipPath, { force: true });
// -X: no extra file attributes, so the zip only depends on file contents.
execFileSync("zip", ["-X", "-q", zipPath, ...files], { cwd: "dist", stdio: "inherit" });
console.log(`\n${zipPath}\n${files.length} files: ${files.join(", ")}`);
