// Pure helpers for scripts/package.mjs: which built files go into the Web Store zip.

/**
 * Files from dist/ (paths relative to dist/, "/"-separated) to put in the upload zip:
 * everything except source maps, sorted for a stable zip. The Web Store needs
 * manifest.json at the zip root, so a build without one is refused.
 * @param {readonly string[]} distFiles
 * @returns {string[]}
 */
export function packageFiles(distFiles) {
  if (!distFiles.includes("manifest.json")) {
    throw new Error("dist/ has no manifest.json at its root; run the build first");
  }
  return distFiles.filter((file) => !file.endsWith(".map")).sort();
}

/**
 * Files the manifest references (icons, service worker, popup, options page) that are
 * not in `files`, sorted and without duplicates. Empty means the package is complete.
 * @param {Record<string, any>} manifest
 * @param {readonly string[]} files
 * @returns {string[]}
 */
export function missingManifestFiles(manifest, files) {
  const referenced = [
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
    manifest.action?.default_popup,
    manifest.background?.service_worker,
    manifest.options_ui?.page,
  ].filter((file) => typeof file === "string");
  const present = new Set(files);
  return [...new Set(referenced)].filter((file) => !present.has(file)).sort();
}
