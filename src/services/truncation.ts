import { parseHTML } from "linkedom";

/**
 * Detects article bodies that are not the whole article: RSS previews that stop
 * at a "Read more" link, and stubs behind a subscriber paywall.
 *
 * Operates on sanitized content (the output of extractArticleFromFeedContent /
 * extractArticle), so a single code path covers both feed-derived and
 * page-derived bodies. Note that sanitizeFeedHtml strips class attributes, so
 * class-based markers such as Substack's div.paywall are already gone by this
 * point; text and link structure are what survive, and they are enough.
 */

export type Completeness =
  | { kind: "complete" }
  | { kind: "truncated"; evidence: string }
  | { kind: "paywalled"; evidence: string };

/**
 * Structural paywall markers, matched against the *raw* page HTML.
 *
 * These must be checked before Readability runs: it discards the paywall widget
 * as non-article furniture, so by the time we hold an extracted body the only
 * trace left is that the prose stops early. Substack's wall, for instance, is a
 * `<div data-testid="paywall" class="paywall">` sitting immediately after the
 * last free paragraph.
 *
 * Deliberately structural rather than phrase-based — scanning a whole page for
 * wording like "subscribe to continue" would misfire on any post that merely
 * discusses paywalls. Attribute-scoped `\bpaywall\b` also avoids the
 * `paywall_chat` / `expose_paywall_content` keys in Substack's inline JSON,
 * since an underscore is a word character.
 */
const RAW_PAYWALL_PATTERNS: RegExp[] = [
  /data-testid=["']paywall["']/i,
  /data-component-name=["']paywall["']/i,
  /aria-label=["']paywall["']/i,
  /class=["'][^"']*\bpaywalled?\b[^"']*["']/i,
  /class=["'][^"']*\bgh-post-upgrade-cta\b[^"']*["']/i,
  /class=["'][^"']*\bpaywall-title\b[^"']*["']/i,
];

/** Phrases that only appear on content gated behind a subscription. */
const PAYWALL_PATTERNS: RegExp[] = [
  /this (?:post|article|content) is for pa(?:id|ying) (?:subscribers|members)/i,
  /this (?:post|article|content) is for (?:subscribers|members)(?: only)?\b/i,
  /subscribe to (?:continue|keep) reading/i,
  /become a (?:paid )?(?:subscriber|member) to (?:read|continue)/i,
  /upgrade to (?:paid|premium)/i,
  /for pa(?:id|ying) (?:subscribers|members) only/i,
  /(?:sign|log) in to (?:read|continue)/i,
  /continue reading this post for free/i,
];

/** Anchor text that signals the body was cut short and continues elsewhere. */
const CONTINUATION_PATTERNS: RegExp[] = [
  /^read more\b/i,
  /^continue reading\b/i,
  /^read (?:the )?(?:full|rest|more)\b/i,
  /^keep reading\b/i,
  /^view (?:this |the )?(?:full )?(?:post|article|story)\b/i,
  /^see more\b/i,
  /^read on\b/i,
  /^(?:…|\.\.\.)$/,
];

/** How much of the tail to scan for paywall wording. */
const TAIL_SCAN_CHARS = 600;

/** A trailing link block longer than this reads as prose, not a "Read more". */
const MAX_MARKER_TEXT_CHARS = 80;

const BLOCK_SELECTOR = "p, div, section, footer, li, blockquote, h1, h2, h3, h4, h5, h6";

// The project targets lib: ["ESNext"] with no DOM types, so borrow linkedom's.
type ParsedDocument = ReturnType<typeof parseHTML>["document"];
type ParsedElement = NonNullable<ReturnType<ParsedDocument["querySelector"]>>;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Normalizes a URL to origin + path so trailing slashes and queries don't matter. */
function normalizeUrl(url: string, base?: string): string | null {
  try {
    const parsed = new URL(url, base);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${path}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when the link targets an anchor within a page rather than a page.
 *
 * Footnote backlinks — DYNOMIGHT closes posts with
 * `<p>Hi Twitter.<a href="https://dynomight.net/betteridge/#fnref:2">↩</a></p>`
 * — otherwise read as self-links once the fragment is normalized away, and a
 * complete article gets thrown out. A genuine "continue reading" link never
 * points at a fragment of the page you are already on.
 */
function hasFragment(href: string, base: string): boolean {
  try {
    return new URL(href, base).hash !== "";
  } catch {
    return href.includes("#");
  }
}

function matchAny(patterns: RegExp[], text: string): string | null {
  for (const pattern of patterns) {
    const found = text.match(pattern);
    if (found) return found[0];
  }
  return null;
}

/**
 * The last block-level element holding actual text, ignoring wrappers that only
 * contain further blocks and empties such as trailing <hr/> or leftover <div/>.
 */
function lastTextBlock(document: ParsedDocument): ParsedElement | null {
  const blocks = document.querySelectorAll(BLOCK_SELECTOR);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const el = blocks[i];
    if (el.querySelector(BLOCK_SELECTOR)) continue;
    if (!collapse(el.textContent ?? "")) continue;
    return el;
  }
  return null;
}

/**
 * Classifies whether a body is the complete article.
 *
 * Paywalls are checked first, since a gated stub often carries a continuation
 * link too and the paywall verdict is the more useful one to report.
 *
 * Truncation is deliberately structural: the final block must be a lone short
 * link that either says something like "Read more" or points back at the
 * article itself. Requiring all three conditions keeps an ordinary closing
 * sentence containing a link — or a footnote list full of outbound links —
 * from being mistaken for a cut.
 */
export function classifyCompleteness(
  contentHtml: string,
  articleUrl: string,
): Completeness {
  if (!contentHtml.trim()) return { kind: "complete" };

  const { document } = parseHTML(`<!DOCTYPE html><html><body>${contentHtml}</body></html>`);

  const fullText = collapse(document.body?.textContent ?? "");
  const paywall = matchAny(PAYWALL_PATTERNS, fullText.slice(-TAIL_SCAN_CHARS));
  if (paywall) return { kind: "paywalled", evidence: paywall };

  const tail = lastTextBlock(document);
  if (!tail) return { kind: "complete" };

  const anchors = tail.querySelectorAll("a");
  if (anchors.length !== 1) return { kind: "complete" };

  const blockText = collapse(tail.textContent ?? "");
  if (blockText.length > MAX_MARKER_TEXT_CHARS) return { kind: "complete" };

  const anchorText = collapse(anchors[0].textContent ?? "");
  const continuation = matchAny(CONTINUATION_PATTERNS, anchorText);
  if (continuation) return { kind: "truncated", evidence: anchorText };

  const href = anchors[0].getAttribute("href");
  if (href && !hasFragment(href, articleUrl)) {
    const target = normalizeUrl(href, articleUrl);
    const self = normalizeUrl(articleUrl);
    if (target && self && target === self) {
      return { kind: "truncated", evidence: `self-link: ${anchorText || href}` };
    }
  }

  return { kind: "complete" };
}

/**
 * Looks for a paywall widget in raw, un-extracted page HTML. Call this on the
 * fetched page before handing it to Readability; returns the matched marker as
 * evidence, or null if the page appears open.
 */
export function detectRawPaywall(rawHtml: string): string | null {
  return matchAny(RAW_PAYWALL_PATTERNS, rawHtml);
}

/** Plain-text length of a body, for comparing two candidate extractions. */
export function textLength(contentHtml: string): number {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${contentHtml}</body></html>`);
  return collapse(document.body?.textContent ?? "").length;
}
