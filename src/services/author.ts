/**
 * Author resolution. Bylines arrive from several sources of differing quality
 * (feed metadata, Readability, page metadata), so the rules for picking one and
 * for falling back live here rather than being spelled out at each call site.
 */

/** Terminal fallback, used only when nothing else identifies the writer. */
export const UNKNOWN_AUTHOR = "Unknown Author";

/** Longest plausible byline; anything longer is a bio or a stray paragraph. */
const MAX_BYLINE_LENGTH = 100;

/** Most authors a single byline will name before it is abbreviated. */
const MAX_NAMES = 4;

/**
 * Trim a raw byline to a name, or return "" if it isn't one. Rejects URLs
 * (`article:author` is often a profile link) and over-long text.
 */
export function cleanByline(raw: string | null | undefined): string {
  if (!raw) return "";
  const collapsed = raw.replace(/\s+/g, " ").trim();
  // Readability and many templates prefix the name with "By".
  const withoutPrefix = collapsed.replace(/^by[:\s]+/i, "").trim();
  if (!withoutPrefix || withoutPrefix.length > MAX_BYLINE_LENGTH) return "";
  if (/^https?:\/\//i.test(withoutPrefix)) return "";
  return withoutPrefix;
}

/**
 * RSS <author> is specified as an email address, optionally followed by the
 * display name in parentheses. Prefer the name; publishing a bare address as
 * the book's author would be both ugly and a needless leak.
 */
export function nameFromRssAuthor(raw: string): string {
  const parenthesized = /\(([^)]+)\)/.exec(raw);
  if (parenthesized) return cleanByline(parenthesized[1]);
  return /@/.test(raw) ? "" : cleanByline(raw);
}

/** Combine co-author names into one byline, de-duplicated and bounded. */
export function joinNames(names: string[]): string {
  const unique = [...new Set(names.map(cleanByline).filter(Boolean))];
  if (unique.length === 0) return "";
  if (unique.length <= MAX_NAMES) return unique.join(", ");
  return `${unique.slice(0, MAX_NAMES).join(", ")} and others`;
}

/**
 * First candidate that yields a usable name, best evidence first. Returns ""
 * when none do, leaving the choice of fallback to the caller.
 */
export function resolveAuthor(
  ...candidates: (string | null | undefined)[]
): string {
  for (const candidate of candidates) {
    const cleaned = cleanByline(candidate);
    if (cleaned) return cleaned;
  }
  return "";
}

/**
 * Byline for display, which must never be empty. Naming the publication beats
 * admitting ignorance: "Cloudflare Blog" is more use to a reader than
 * "Unknown Author".
 */
export function displayAuthor(
  ...candidates: (string | null | undefined)[]
): string {
  return resolveAuthor(...candidates) || UNKNOWN_AUTHOR;
}
