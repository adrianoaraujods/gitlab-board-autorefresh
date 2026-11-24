/**
 * Validation for a domain entered in the options page. A domain is an origin
 * only: `http(s)://host[:port]`, with no path, query, fragment or credentials.
 */
export type DomainOriginResult = { ok: true; origin: string } | { ok: false; error: string };

const HOSTNAME = /^[a-z0-9.-]+$|^\[[0-9a-f:.]+\]$/;

export function parseDomainOrigin(input: string): DomainOriginResult {
  const text = input.trim();
  if (text === "") return fail("Enter an origin, for example https://gitlab.example.com.");

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail("Not a valid URL. Include the scheme, for example https://gitlab.example.com.");
  }
  if (!text.includes("://")) return fail("Include the scheme, for example https://.");
  if (url.protocol !== "https:" && url.protocol !== "http:") return fail("Only http:// and https:// origins are supported.");
  if (url.username || url.password) return fail("Remove the username and password.");
  if (!HOSTNAME.test(url.hostname)) return fail("The host name contains invalid characters.");
  if (url.pathname !== "/" || text.includes("?") || text.includes("#")) {
    return fail("Enter the origin only (scheme, host and optional port), without a path, query or fragment.");
  }
  return { ok: true, origin: url.origin };
}

/** The host permission / content-script match pattern for an origin. */
export function originMatchPattern(origin: string): string {
  return `${origin}/*`;
}

/** A pattern for exactly one origin, as `originMatchPattern` makes it: no wildcard scheme or host. */
const SINGLE_ORIGIN_PATTERN = /^https?:\/\/[^*/]+\/\*$/;

/**
 * The granted host patterns that no configured domain needs any more (for
 * example, a domain removed on another synced profile), so their access can
 * be given back. Only single-origin patterns, the only kind the options page
 * requests, are ever returned.
 */
export function unneededOriginPatterns(grantedPatterns: readonly string[], configuredOrigins: readonly string[]): string[] {
  const needed = new Set(configuredOrigins.map(originMatchPattern));
  return grantedPatterns.filter((pattern) => SINGLE_ORIGIN_PATTERN.test(pattern) && !needed.has(pattern));
}

function fail(error: string): DomainOriginResult {
  return { ok: false, error };
}
