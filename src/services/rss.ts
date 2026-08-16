import { parseDocument } from "htmlparser2";
import { createLogger } from "../logger.ts";
import { proxiedFetch } from "../http/proxied-fetch.ts";
import { detectChallenge, looksLikeFeedBody } from "../http/challenge.ts";

const FEED_ACCEPT =
  "application/rss+xml,application/atom+xml,application/xml;q=0.9,text/xml;q=0.8,*/*;q=0.7";

const logger = createLogger("rss");

export interface FeedItem {
  guid: string;
  title: string;
  link: string;
  pubDate: number; // ms since epoch
  content: string; // inline HTML content from feed (content:encoded, description, or Atom content)
}

export interface ParsedFeed {
  title: string;
  items: FeedItem[];
}

// Minimal DOM node shape returned by htmlparser2
interface HtmlNode {
  type: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: HtmlNode[];
  data?: string;
}

function findChildren(node: HtmlNode, tagName: string): HtmlNode[] {
  return (node.children || []).filter(
    (n) => n.type === "tag" && n.name?.toLowerCase() === tagName.toLowerCase(),
  );
}

function textContent(node: HtmlNode): string {
  if (node.type === "text") return node.data || "";
  if (node.type === "cdata") {
    // htmlparser2 puts CDATA text in a child Text node, not in .data
    return node.data || (node.children || []).map(textContent).join("");
  }
  return (node.children || []).map(textContent).join("").trim();
}

function childText(node: HtmlNode, tagName: string): string {
  const child = findChildren(node, tagName)[0];
  return child ? textContent(child) : "";
}

function findDeep(nodes: HtmlNode[], tagName: string): HtmlNode | null {
  for (const node of nodes) {
    if (
      node.type === "tag" &&
      node.name?.toLowerCase() === tagName.toLowerCase()
    ) {
      return node;
    }
    if (node.children) {
      const found = findDeep(node.children, tagName);
      if (found) return found;
    }
  }
  return null;
}

function parseRss(doc: HtmlNode): ParsedFeed {
  const channel = findDeep(doc.children || [], "channel");
  if (!channel) return { title: "", items: [] };

  const feedTitle = childText(channel, "title");
  const itemNodes = findChildren(channel, "item");

  const items: FeedItem[] = [];
  for (const item of itemNodes) {
    const title = childText(item, "title");
    const link = childText(item, "link");
    const guid = childText(item, "guid") || link;
    const pubDateStr = childText(item, "pubdate");
    const pubDate = pubDateStr ? Date.parse(pubDateStr) : Date.now();
    const content = childText(item, "content:encoded");

    if (link) {
      items.push({
        guid: guid || link,
        title,
        link,
        content,
        pubDate: isNaN(pubDate) ? Date.now() : pubDate,
      });
    }
  }

  return { title: feedTitle, items };
}

function parseAtom(doc: HtmlNode): ParsedFeed {
  const feed = findDeep(doc.children || [], "feed");
  if (!feed) return { title: "", items: [] };

  // Get only direct children <title> to avoid picking up entry titles
  const feedTitle = childText(feed, "title");
  const entries = findChildren(feed, "entry");
  const items: FeedItem[] = [];

  for (const entry of entries) {
    const title = childText(entry, "title");

    // Atom <link> has href attribute; prefer rel="alternate"
    const linkNodes = findChildren(entry, "link");
    let link = "";
    for (const ln of linkNodes) {
      const rel = ln.attribs?.rel ?? "alternate";
      if (rel === "alternate" || rel === "") {
        link = ln.attribs?.href || "";
        break;
      }
    }
    if (!link && linkNodes.length > 0) {
      link = linkNodes[0].attribs?.href || "";
    }

    const guid = childText(entry, "id") || link;
    const dateStr =
      childText(entry, "updated") || childText(entry, "published");
    const pubDate = dateStr ? Date.parse(dateStr) : Date.now();
    // Atom content element (often has type="html") or summary as fallback
    const contentEl = childText(entry, "content");
    const summary = childText(entry, "summary");
    const content = contentEl || summary || "";

    if (link) {
      items.push({
        guid: guid || link,
        title,
        link,
        content,
        pubDate: isNaN(pubDate) ? Date.now() : pubDate,
      });
    }
  }

  return { title: feedTitle, items };
}

export function parseFeedXml(xml: string): ParsedFeed {
  const doc = parseDocument(xml, { xmlMode: true }) as unknown as HtmlNode;
  const isAtom = findDeep(doc.children || [], "feed") !== null;
  return isAtom ? parseAtom(doc) : parseRss(doc);
}

/**
 * Thrown when a host serves a bot challenge instead of the requested document.
 * Distinct from a transport failure so callers can explain it to the user.
 */
export class FeedBlockedError extends Error {
  readonly url: string;
  readonly detail: string;

  constructor(url: string, detail: string) {
    super(
      `${new URL(url).host} is blocking automated requests (${detail}). ` +
        `The feed is readable in a browser but not from our servers.`,
    );
    this.name = "FeedBlockedError";
    this.url = url;
    this.detail = detail;
  }
}

export async function fetchAndParseFeed(feedUrl: string): Promise<ParsedFeed> {
  logger.debug({ feedUrl }, "Fetching RSS feed");
  const resp = await proxiedFetch(feedUrl, {
    signal: AbortSignal.timeout(20000),
    headers: { Accept: FEED_ACCEPT },
  });
  const contentType = resp.headers.get("content-type") || "";
  const text = await resp.text();

  const challenge = detectChallenge(resp.status, contentType, text);
  if (challenge) {
    logger.warn({ feedUrl, status: resp.status, challenge }, "Feed request was challenged");
    throw new FeedBlockedError(feedUrl, challenge);
  }
  if (!resp.ok) {
    logger.error({ feedUrl, status: resp.status }, "Failed to fetch feed");
    throw new Error(`Failed to fetch feed: HTTP ${resp.status}`);
  }

  // Without this an interstitial or error page parses to an empty feed, and the
  // caller stores a subscription that silently never produces a post.
  if (!looksLikeFeedBody(text)) {
    logger.error({ feedUrl, contentType }, "Response was not a feed document");
    throw new Error(
      `${feedUrl} did not return an RSS or Atom feed (got ${contentType || "an unrecognised document"}).`,
    );
  }

  return parseFeedXml(text);
}

/** Why feed discovery failed, when it did. */
export type FeedDiscoveryFailure = "blocked" | "unreachable" | "no-feed";

export type FeedDiscovery =
  | { feedUrl: string }
  | { reason: FeedDiscoveryFailure; detail?: string };

/** Feed locations to probe when the page advertises none, in priority order. */
const COMMON_FEED_PATHS = [
  "/feed",
  "/feed/",
  "/rss",
  "/rss.xml",
  "/feed.xml",
  "/atom.xml",
  "/index.xml",
  "/feed/index.xml",
  // WordPress without pretty permalinks — the only feed such sites expose.
  "/?feed=rss2",
  "/?feed=atom",
  "/feeds/posts/default",
  "/blog/feed",
  "/blog/rss.xml",
];

/** Probes run per round, to avoid hitting a host with a burst of requests. */
const PROBE_BATCH_SIZE = 4;

/** Extract feed URLs declared by <link rel="alternate" type="...rss|atom..."> */
function feedLinksFromHtml(html: string, baseUrl: string): string[] {
  const found: string[] = [];
  const linkTagRe = /<link([^>]+)>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkTagRe.exec(html)) !== null) {
    const attrs = m[1];
    if (
      !/rel=["']alternate["']/i.test(attrs) ||
      !/type=["'][^"']*(rss|atom)[^"']*["']/i.test(attrs)
    ) {
      continue;
    }
    const href = /href=["']([^"']+)["']/i.exec(attrs)?.[1];
    if (!href) continue;
    try {
      found.push(new URL(href, baseUrl).href);
    } catch {
      /* malformed href — ignore */
    }
  }
  return found;
}

/** Same-host <a href> values that look like they point at a feed. */
function feedAnchorsFromHtml(html: string, baseUrl: string, limit: number): string[] {
  const base = new URL(baseUrl);
  const found: string[] = [];
  const anchorRe = /<a[^>]+href=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null && found.length < limit) {
    const raw = m[1];
    if (!/(feed|rss|atom)/i.test(raw)) continue;
    try {
      const url = new URL(raw, baseUrl);
      if (url.host !== base.host) continue;
      if (!found.includes(url.href)) found.push(url.href);
    } catch {
      /* malformed href — ignore */
    }
  }
  return found;
}

/** Candidate feed URLs built from well-known paths, root-relative and page-relative. */
function commonPathCandidates(blogUrl: string): string[] {
  const base = new URL(blogUrl);
  const candidates = COMMON_FEED_PATHS.map((path) => new URL(path, base.origin).href);

  // A URL like https://example.com/blog/ may keep its feed alongside the posts
  // rather than at the origin root.
  if (base.pathname !== "/") {
    const dir = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
    for (const name of ["feed", "feed/", "rss.xml", "index.xml", "atom.xml"]) {
      candidates.push(new URL(name, `${base.origin}${dir}`).href);
    }
  }

  return [...new Set(candidates)];
}

/** GET the first couple of KB of a candidate and confirm it is really a feed. */
async function probeIsFeed(candidateUrl: string): Promise<boolean> {
  try {
    const resp = await proxiedFetch(candidateUrl, {
      signal: AbortSignal.timeout(8000),
      // Hosts that ignore Range just send the whole feed, which is still fine.
      headers: { Accept: FEED_ACCEPT, Range: "bytes=0-2047" },
    });
    if (!resp.ok) return false;
    const body = await resp.text();
    if (detectChallenge(resp.status, resp.headers.get("content-type") || "", body)) {
      return false;
    }
    return looksLikeFeedBody(body);
  } catch {
    return false;
  }
}

/**
 * Probe candidates in small batches, returning the first that validates in the
 * order given (priority is preserved even though a batch runs concurrently).
 */
async function firstValidFeed(candidates: string[]): Promise<string | null> {
  for (let i = 0; i < candidates.length; i += PROBE_BATCH_SIZE) {
    const batch = candidates.slice(i, i + PROBE_BATCH_SIZE);
    const results = await Promise.all(batch.map(probeIsFeed));
    const hit = results.indexOf(true);
    if (hit !== -1) return batch[hit];
  }
  return null;
}

/** Attempt to find an RSS/Atom feed URL given a blog URL. */
export async function detectFeedUrl(blogUrl: string): Promise<FeedDiscovery> {
  let status: number;
  let contentType: string;
  let body: string;
  try {
    const resp = await proxiedFetch(blogUrl, {
      signal: AbortSignal.timeout(15000),
      headers: { Accept: FEED_ACCEPT },
    });
    status = resp.status;
    contentType = resp.headers.get("content-type") || "";
    body = await resp.text();
  } catch (err) {
    logger.warn({ blogUrl, err: (err as Error).message }, "Could not fetch URL for discovery");
    return { reason: "unreachable", detail: (err as Error).message };
  }

  const challenge = detectChallenge(status, contentType, body);
  if (challenge) {
    logger.warn({ blogUrl, status, challenge }, "Discovery request was challenged");
    return { reason: "blocked", detail: challenge };
  }
  if (status < 200 || status >= 300) {
    logger.warn({ blogUrl, status }, "Discovery request failed");
    return { reason: "unreachable", detail: `HTTP ${status}` };
  }

  // The submitted URL may already be the feed.
  if (looksLikeFeedBody(body)) return { feedUrl: blogUrl };

  // Trust the site's own declaration without a confirming request; if it turns
  // out to be unreadable, fetchAndParseFeed reports why.
  const declared = feedLinksFromHtml(body, blogUrl);
  if (declared.length > 0) return { feedUrl: declared[0] };

  const guessed = await firstValidFeed(commonPathCandidates(blogUrl));
  if (guessed) return { feedUrl: guessed };

  // Last resort: links in the page that look feed-shaped.
  const fromAnchors = await firstValidFeed(feedAnchorsFromHtml(body, blogUrl, 5));
  if (fromAnchors) return { feedUrl: fromAnchors };

  logger.info({ blogUrl }, "No feed found");
  return { reason: "no-feed" };
}
