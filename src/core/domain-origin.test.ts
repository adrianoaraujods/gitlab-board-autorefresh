import { describe, expect, it } from "vitest";
import { parseDomainOrigin, unneededOriginPatterns } from "./domain-origin";

describe("parseDomainOrigin", () => {
  it.each([
    ["https://gitlab.com", "https://gitlab.com"],
    ["https://gitlab.com/", "https://gitlab.com"],
    ["  https://example.com  ", "https://example.com"],
    ["https://Example.COM", "https://example.com"],
    ["https://example.com:8443", "https://example.com:8443"],
    ["https://example.com:443", "https://example.com"],
    ["http://localhost:8080", "http://localhost:8080"],
  ])("accepts %s as %s", (input, origin) => {
    expect(parseDomainOrigin(input)).toEqual({ ok: true, origin });
  });

  it.each([
    ["empty", ""],
    ["no scheme", "example.com"],
    ["unsupported scheme", "ftp://example.com"],
    ["path", "https://example.com/gitlab"],
    ["query", "https://example.com?x=1"],
    ["hash", "https://example.com#top"],
    ["credentials", "https://user:pass@example.com"],
    ["wildcard host", "https://*.example.com"],
    ["garbage", "not a domain"],
  ])("rejects %s (%j) with an error", (_name, input) => {
    const result = parseDomainOrigin(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toBe("");
  });
});

describe("unneededOriginPatterns", () => {
  it("returns the pattern of a granted origin that is no longer configured", () => {
    expect(
      unneededOriginPatterns(["https://gitlab.com/*", "https://gitlab.example.com/*"], ["https://gitlab.com"]),
    ).toEqual(["https://gitlab.example.com/*"]);
  });

  it("keeps every pattern a configured domain still needs", () => {
    expect(
      unneededOriginPatterns(
        ["https://gitlab.com/*", "http://localhost:8080/*"],
        ["http://localhost:8080", "https://gitlab.com"],
      ),
    ).toEqual([]);
  });

  it("tells ports and schemes apart", () => {
    expect(
      unneededOriginPatterns(
        ["https://gitlab.example.com:8443/*", "http://gitlab.example.com/*"],
        ["https://gitlab.example.com"],
      ),
    ).toEqual(["https://gitlab.example.com:8443/*", "http://gitlab.example.com/*"]);
  });

  it("leaves wildcard grants alone, which the options page never requests", () => {
    expect(
      unneededOriginPatterns(["https://*/*", "<all_urls>", "*://*.example.com/*", "https://*.example.com/*"], []),
    ).toEqual([]);
  });
});
