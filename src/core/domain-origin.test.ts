import { describe, expect, it } from "vitest";
import { parseDomainOrigin } from "./domain-origin";

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
