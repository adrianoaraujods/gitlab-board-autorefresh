// Keeps the Web Store listing honest: it must justify exactly the permissions the
// manifest declares, and the extension must present itself as "for GitLab".
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync("src/manifest.json", "utf8"));
const listing = readFileSync("store/listing.md", "utf8");

/** `### \`name\`` headings under "## Permission justifications". */
function justifiedPermissions(markdown: string): string[] {
  const section = markdown.split(/^## Permission justifications$/m)[1]?.split(/^## /m)[0] ?? "";
  return [...section.matchAll(/^### `([^`]+)`$/gm)].map((match) => match[1]!).sort();
}

describe("store listing", () => {
  it("justifies exactly the declared permissions and optional host permissions", () => {
    const declared = [...manifest.permissions, ...(manifest.optional_host_permissions ?? [])].sort();
    expect(justifiedPermissions(listing)).toEqual(declared);
  });

  it("declares no host permissions up front", () => {
    expect(manifest.host_permissions).toBeUndefined();
  });

  it("names the extension as being for GitLab, not an official GitLab product", () => {
    expect(manifest.name).toMatch(/for GitLab/);
    expect(manifest.description).toMatch(/for GitLab/);
    expect(manifest.description).toMatch(/Not an official GitLab product/);
    expect(listing).toContain(`Name: ${manifest.name}`);
    expect(listing).toContain(manifest.description);
  });
});
