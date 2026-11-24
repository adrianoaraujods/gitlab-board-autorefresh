import { describe, expect, it } from "vitest";
import { missingManifestFiles, packageFiles } from "./package-contents.mjs";

describe("packageFiles", () => {
  it("keeps every built file except source maps, sorted, with manifest.json at the zip root", () => {
    expect(
      packageFiles([
        "popup.js",
        "manifest.json",
        "background.js",
        "background.js.map",
        "icons/icon-16.png",
        "popup.js.map",
      ]),
    ).toEqual(["background.js", "icons/icon-16.png", "manifest.json", "popup.js"]);
  });

  it("refuses a build without manifest.json at its root", () => {
    expect(() => packageFiles(["background.js", "sub/manifest.json"])).toThrow(/manifest\.json/);
  });
});

describe("missingManifestFiles", () => {
  const manifest = {
    icons: { "16": "icons/icon-16.png", "128": "icons/icon-128.png" },
    background: { service_worker: "background.js" },
    action: { default_popup: "popup.html", default_icon: { "16": "icons/icon-16.png" } },
    options_ui: { page: "options.html" },
  };

  it("is empty when every file the manifest references is packaged", () => {
    expect(
      missingManifestFiles(manifest, [
        "background.js",
        "icons/icon-128.png",
        "icons/icon-16.png",
        "manifest.json",
        "options.html",
        "popup.html",
      ]),
    ).toEqual([]);
  });

  it("lists each referenced file that is not packaged, once", () => {
    expect(missingManifestFiles(manifest, ["background.js", "manifest.json", "popup.html"])).toEqual([
      "icons/icon-128.png",
      "icons/icon-16.png",
      "options.html",
    ]);
  });
});
