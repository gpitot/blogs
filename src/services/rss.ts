import { parseDocument } from "htmlparser2";
import { createLogger } from "../logger.ts";

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

export async function fetchAndParseFeed(feedUrl: string): Promise<ParsedFeed> {
  logger.debug({ feedUrl }, "Fetching RSS feed");
  const resp = await fetch(feedUrl, {
    signal: AbortSignal.timeout(20000),
    headers: { "User-Agent": "Mozilla/5.0 (compatible; BlogToEpub/1.0)" },
  });
  if (!resp.ok) {
    logger.error({ feedUrl, status: resp.status }, "Failed to fetch feed");
    throw new Error(`Failed to fetch feed: HTTP ${resp.status}`);
  }
  const text = await resp.text();
  return parseFeedXml(text);
}

/** Attempt to find an RSS/Atom feed URL given a blog URL. */
export async function detectFeedUrl(blogUrl: string): Promise<string | null> {
  let html: string;
  try {
    const resp = await fetch(blogUrl, {
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BlogToEpub/1.0)" },
    });
    if (!resp.ok) return null;

    const ct = resp.headers.get("content-type") || "";
    if (
      ct.includes("application/rss+xml") ||
      ct.includes("application/atom+xml") ||
      ct.includes("application/xml") ||
      ct.includes("text/xml")
    ) {
      return blogUrl;
    }

    html = await resp.text();
  } catch {
    return null;
  }

  // Scan for <link rel="alternate" type="...rss/atom..." href="...">
  // Handles both attribute orderings
  const linkTagRe = /<link([^>]+)>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkTagRe.exec(html)) !== null) {
    const attrs = m[1];
    if (
      /rel=["']alternate["']/i.test(attrs) &&
      /type=["'][^"']*(rss|atom)[^"']*["']/i.test(attrs)
    ) {
      const hrefMatch = /href=["']([^"']+)["']/i.exec(attrs);
      if (hrefMatch) {
        try {
          return new URL(hrefMatch[1], blogUrl).href;
        } catch {
          /* ignore */
        }
      }
    }
  }

  // Try common feed paths
  const { protocol, host } = new URL(blogUrl);
  const commonPaths = [
    "/feed",
    "/rss",
    "/feed.xml",
    "/rss.xml",
    "/atom.xml",
    "/feeds/posts/default",
  ];

  for (const path of commonPaths) {
    const feedUrl = `${protocol}//${host}${path}`;
    try {
      const probe = await fetch(feedUrl, {
        method: "HEAD",
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; BlogToEpub/1.0)" },
      });
      if (probe.ok) {
        const ct = probe.headers.get("content-type") || "";
        if (ct.includes("xml") || ct.includes("rss") || ct.includes("atom")) {
          return feedUrl;
        }
      }
    } catch {
      /* ignore */
    }
  }

  return null;
}
