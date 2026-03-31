import { Hono } from "hono";
import {
  extractArticle,
  extractArticleFromFeedContent,
  extractCanonicalUrl,
} from "./services/clean.ts";
import { generateEpub } from "./services/epub.ts";
import { processArticleImages } from "./services/images.ts";
import {
  detectFeedUrl,
  fetchAndParseFeed,
  type FeedItem,
} from "./services/rss.ts";
import {
  urlToKey,
  getCached,
  putCached,
  putEpub,
  getEpub,
  listSubscriptions,
  getSubscription,
  putSubscription,
  deleteSubscription,
  generateId,
  putPendingArticle,
  getPendingArticle,
  listWeeklyBooks,
  addWeeklyBook,
  getWeeklyBookData,
  MAX_SEEN_GUIDS,
  MAX_RECENT_ARTICLES,
  type Env,
  type Subscription,
  type PendingArticle,
  type WeeklyBookMeta,
} from "./storage.ts";
import { renderUI, renderSubscriptionsUI, renderWeeklyBooksUI } from "./ui.ts";

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Single-article conversion (on-demand)
// ---------------------------------------------------------------------------

app.get("/", (c) => {
  return renderUI();
});

app.post("/convert", async (c) => {
  let blogUrl: string;

  try {
    const body = await c.req.formData();
    const raw = body.get("url");
    if (!raw || typeof raw !== "string") {
      return renderUI({ error: "Please provide a URL." });
    }
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return renderUI({ error: "Only http and https URLs are supported." });
    }
    blogUrl = parsed.href;
  } catch {
    return renderUI({
      error: "Invalid URL. Please enter a valid blog post URL.",
    });
  }

  const cacheKey = await urlToKey(blogUrl);
  const cached = await getCached(c.env, cacheKey);
  if (cached) {
    return c.redirect(`/download/${cacheKey.replace("epub:", "")}`, 303);
  }

  let html: string;
  try {
    const resp = await fetch(blogUrl, {
      signal: AbortSignal.timeout(25000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BlogToEpub/1.0)" },
    });
    if (!resp.ok) {
      return renderUI({
        error: `Could not fetch that URL (HTTP ${resp.status}). Is it publicly accessible?`,
      });
    }
    html = await resp.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return renderUI({ error: `Failed to fetch the URL: ${msg}` });
  }

  let article: ReturnType<typeof extractArticle>;
  try {
    article = extractArticle(html, blogUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return renderUI({ error: `Could not extract article content: ${msg}` });
  }

  const { html: contentWithImages, images } = await processArticleImages(
    article.content,
    blogUrl,
  );
  article.content = contentWithImages;

  let epubBytes: Uint8Array;
  try {
    epubBytes = generateEpub(
      article.title || "Article",
      article.byline || "Unknown Author",
      [article],
      images,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return renderUI({ error: `Failed to generate EPUB: ${msg}` });
  }

  const kvKey = `epub-data:${cacheKey.replace("epub:", "")}`;
  await putEpub(c.env, kvKey, epubBytes);
  await putCached(c.env, cacheKey, {
    kvKey,
    title: article.title || "Article",
    createdAt: Date.now(),
    size: epubBytes.byteLength,
  });

  return c.redirect(`/download/${cacheKey.replace("epub:", "")}`, 303);
});

app.get("/download/:key", async (c) => {
  const key = c.req.param("key");
  if (!/^[a-f0-9]+$/.test(key)) {
    return c.notFound();
  }

  const cacheKey = `epub:${key}`;
  const cached = await getCached(c.env, cacheKey);

  if (!cached) {
    return c.html(
      `<html><body><p>EPUB not found or expired. <a href="/">Convert again</a></p></body></html>`,
      404,
    );
  }

  const response = await getEpub(
    c.env,
    cached.kvKey,
    cached.title,
    cached.size,
  );
  if (!response) {
    return c.html(
      `<html><body><p>EPUB not found. <a href="/">Convert again</a></p></body></html>`,
      404,
    );
  }
  return response;
});

// ---------------------------------------------------------------------------
// Per-article download (subscription articles – lazy EPUB generation)
// ---------------------------------------------------------------------------

app.get("/download/article/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[a-f0-9]+$/.test(id)) {
    return c.notFound();
  }

  const article = await getPendingArticle(c.env, id);
  if (!article) {
    return c.html(
      `<html><body><p>Article not found or expired. <a href="/subscriptions">View subscriptions</a></p></body></html>`,
      404,
    );
  }

  const { html: contentWithImages, images } = await processArticleImages(
    article.content,
    article.url,
  );

  const epubBytes = generateEpub(
    article.title,
    article.byline || "Unknown Author",
    [
      {
        title: article.title,
        byline: article.byline,
        content: contentWithImages,
      },
    ],
    images,
  );

  const safeTitle =
    article.title.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim() || "article";
  return new Response(epubBytes, {
    headers: {
      "Content-Type": "application/epub+zip",
      "Content-Disposition": `attachment; filename="${safeTitle}.epub"`,
      "Content-Length": epubBytes.byteLength.toString(),
    },
  });
});

// ---------------------------------------------------------------------------
// Blog subscriptions
// ---------------------------------------------------------------------------

app.get("/subscriptions", async (c) => {
  const subs = await listSubscriptions(c.env);
  return renderSubscriptionsUI(subs);
});

app.post("/subscriptions", async (c) => {
  const body = await c.req.formData();
  const raw = body.get("url");

  if (!raw || typeof raw !== "string") {
    const subs = await listSubscriptions(c.env);
    return renderSubscriptionsUI(subs, { error: "Please provide a URL." });
  }

  let siteUrl: string;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      const subs = await listSubscriptions(c.env);
      return renderSubscriptionsUI(subs, {
        error: "Only http and https URLs are supported.",
      });
    }
    siteUrl = parsed.href;
  } catch {
    const subs = await listSubscriptions(c.env);
    return renderSubscriptionsUI(subs, { error: "Invalid URL." });
  }

  const feedUrl = await detectFeedUrl(siteUrl);
  if (!feedUrl) {
    const subs = await listSubscriptions(c.env);
    return renderSubscriptionsUI(subs, {
      error:
        "Could not find an RSS or Atom feed for that URL. Please provide the feed URL directly.",
    });
  }

  let feed;
  try {
    feed = await fetchAndParseFeed(feedUrl);
  } catch (err) {
    const subs = await listSubscriptions(c.env);
    return renderSubscriptionsUI(subs, {
      error: `Failed to read feed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const sub: Subscription = {
    id: generateId(),
    feedUrl,
    siteUrl,
    title: feed.title || siteUrl,
    addedAt: Date.now(),
    lastChecked: Date.now(),
    // Mark all items as seen EXCEPT the latest 5, so the next scheduled
    // run will download those 5 most recent posts for the new subscription.
    seenGuids: feed.items
      .sort((a, b) => b.pubDate - a.pubDate)
      .slice(5)
      .map((i) => i.guid)
      .slice(0, MAX_SEEN_GUIDS),
    recentArticles: [],
  };

  await putSubscription(c.env, sub);

  const subs = await listSubscriptions(c.env);
  return renderSubscriptionsUI(subs, {
    success: `Subscribed to "${sub.title}". New posts will appear in your weekly book.`,
  });
});

app.post("/subscriptions/:id/delete", async (c) => {
  const id = c.req.param("id");
  if (!/^[a-f0-9]+$/.test(id)) {
    return c.notFound();
  }
  await deleteSubscription(c.env, id);
  return c.redirect("/subscriptions", 303);
});

// ---------------------------------------------------------------------------
// Weekly books
// ---------------------------------------------------------------------------

app.get("/weekly-books", async (c) => {
  const books = await listWeeklyBooks(c.env);
  return renderWeeklyBooksUI(books);
});

app.get("/download/weekly/:weekKey", async (c) => {
  const weekKey = c.req.param("weekKey");
  if (!/^\d{4}-W\d{2}$/.test(weekKey)) {
    return c.notFound();
  }

  const result = await getWeeklyBookData(c.env, weekKey);
  if (!result) {
    return c.html(
      `<html><body><p>Weekly book not found or expired. <a href="/weekly-books">View all books</a></p></body></html>`,
      404,
    );
  }

  const safeTitle =
    result.meta.title.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim() ||
    "weekly-reading";

  return new Response(result.buf, {
    headers: {
      "Content-Type": "application/epub+zip",
      "Content-Disposition": `attachment; filename="${safeTitle}.epub"`,
      "Content-Length": result.meta.size.toString(),
      "Cache-Control": "public, max-age=86400",
    },
  });
});

// ---------------------------------------------------------------------------
// Scheduled handler
// ---------------------------------------------------------------------------

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; BlogToEpub/1.0)",
};

/** Fetch HTML from a URL, returning null on failure. */
async function fetchHtml(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(25000),
      headers: FETCH_HEADERS,
    });
    if (!resp.ok) {
      console.log(`[weekly] Failed to fetch ${url}: HTTP ${resp.status}`);
      return null;
    }
    return await resp.text();
  } catch (err) {
    console.log(`[weekly] Error fetching ${url}:`, err);
    return null;
  }
}

/**
 * Some RSS feeds have broken article URLs (e.g. /blog/slug instead of /slug).
 * If the fetched page's canonical URL points to the homepage, derive a
 * candidate URL by placing the slug directly at the site root.
 */
function deriveCorrectUrl(
  feedUrl: string,
  canonicalUrl: string,
): string | null {
  try {
    const canonical = new URL(canonicalUrl, feedUrl);
    // Only act if canonical is the homepage (path is "/" or empty)
    if (canonical.pathname !== "/" && canonical.pathname !== "") return null;

    const feed = new URL(feedUrl);
    // Extract the last non-empty path segment (the slug)
    const segments = feed.pathname.split("/").filter(Boolean);
    if (segments.length === 0) return null;
    const slug = segments[segments.length - 1];

    const candidate = new URL(`/${slug}/`, feed.origin);
    // Don't retry the same URL
    if (candidate.href === feed.href) return null;
    return candidate.href;
  } catch {
    return null;
  }
}

/** Fetch a new subscription article, save its content for later use. */
async function fetchAndSaveArticle(
  env: Env,
  item: FeedItem,
  subId: string,
  subTitle: string,
): Promise<PendingArticle | null> {
  let article: { title: string; content: string; byline: string } | null = null;
  let articleUrl = item.link;

  // If the feed includes substantial inline content (e.g. content:encoded),
  // use it directly — it's authoritative and avoids SPA/scraping issues.
  if (item.content && item.content.length >= 500) {
    article = extractArticleFromFeedContent(
      item.content,
      item.title,
      item.link,
    );
  } else {
    // Fetch the URL from the feed
    const html = await fetchHtml(item.link);

    if (html) {
      // Check canonical URL — if it points to the homepage, the feed URL is
      // probably wrong (e.g. /blog/slug instead of /slug).
      const canonical = extractCanonicalUrl(html);
      const correctedUrl = canonical
        ? deriveCorrectUrl(item.link, canonical)
        : null;

      if (correctedUrl) {
        console.log(
          `[weekly] Feed URL "${item.link}" has homepage canonical, retrying with "${correctedUrl}"`,
        );
        const retryHtml = await fetchHtml(correctedUrl);
        if (retryHtml) {
          article = extractArticle(retryHtml, correctedUrl);
          articleUrl = correctedUrl;
        }
      } else {
        article = extractArticle(html, item.link);
      }

      // Validate extraction — detect homepage/link-list extractions
      if (article && !looksLikeArticle(article, item.title)) {
        console.log(
          `[weekly] Readability extracted wrong content for "${item.title}" (got "${article.title}")`,
        );
        article = null;
      }
    }

    // Fall back to feed inline content (description/summary)
    if (!article && item.content) {
      article = extractArticleFromFeedContent(
        item.content,
        item.title,
        item.link,
      );
    }
  }

  if (!article || !article.content) {
    console.log(`[weekly] No content available for "${item.title}", skipping`);
    return null;
  }

  const pending: PendingArticle = {
    id: generateId(),
    url: articleUrl,
    title: article.title || item.title || "Article",
    byline: article.byline || "Unknown Author",
    content: article.content,
    savedAt: Date.now(),
    subId,
    subTitle,
  };

  await putPendingArticle(env, pending);
  return pending;
}

/** Check if a Readability extraction looks like actual article content. */
function looksLikeArticle(
  extracted: { title: string; content: string },
  expectedTitle: string,
): boolean {
  // If Readability got a title that roughly matches the feed item title, it's good.
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const extractedNorm = normalize(extracted.title);
  const expectedNorm = normalize(expectedTitle);
  if (extractedNorm && expectedNorm && extractedNorm.includes(expectedNorm)) {
    return true;
  }
  if (extractedNorm && expectedNorm && expectedNorm.includes(extractedNorm)) {
    return true;
  }

  // If the content is very short or mostly links, it's probably a homepage/index.
  const textOnly = extracted.content.replace(/<[^>]+>/g, "");
  if (textOnly.length < 100) return false;

  // Count links vs text ratio — homepages are mostly links
  const linkCount = (extracted.content.match(/<a /g) || []).length;
  if (linkCount > 10 && textOnly.length / linkCount < 50) return false;

  return true;
}

async function checkSubscription(
  env: Env,
  sub: Subscription,
): Promise<PendingArticle[]> {
  const feed = await fetchAndParseFeed(sub.feedUrl);

  const seenSet = new Set(sub.seenGuids);
  const newItems = feed.items
    // .filter((item) => !seenSet.has(item.guid))
    .sort((a, b) => b.pubDate - a.pubDate)
    .slice(0, 5);

  const saved: PendingArticle[] = [];
  const newGuids: string[] = [];
  console.log(JSON.stringify(newItems));

  for (const item of newItems) {
    newGuids.push(item.guid);
    try {
      const article = await fetchAndSaveArticle(env, item, sub.id, sub.title);
      if (article) saved.push(article);
    } catch (err) {
      console.error(`[weekly] Failed to save ${item.link}:`, err);
    }
  }

  const newRecentArticles = saved.map((a) => ({
    id: a.id,
    title: a.title,
    createdAt: a.savedAt,
  }));

  await putSubscription(env, {
    ...sub,
    lastChecked: Date.now(),
    seenGuids: [...newGuids, ...sub.seenGuids].slice(0, MAX_SEEN_GUIDS),
    recentArticles: [...newRecentArticles, ...sub.recentArticles].slice(
      0,
      MAX_RECENT_ARTICLES,
    ),
  });

  console.log(`[weekly] "${sub.title}": ${saved.length} new articles saved.`);
  return saved;
}

function getISOWeekNumber(date: Date): number {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

async function runWeeklyJob(env: Env): Promise<void> {
  console.log("[weekly] Checking subscriptions and compiling book...");
  const subs = await listSubscriptions(env);

  const allArticles: PendingArticle[] = [];
  for (const sub of subs) {
    try {
      const saved = await checkSubscription(env, sub);
      allArticles.push(...saved);
    } catch (err) {
      console.error(`[weekly] Error checking "${sub.title}":`, err);
    }
  }

  if (allArticles.length === 0) {
    console.log(
      "[weekly] No new articles this week, skipping book generation.",
    );
    return;
  }

  console.log(`[weekly] Compiling ${allArticles.length} articles into book...`);

  const now = new Date();
  const weekNum = getISOWeekNumber(now).toString().padStart(2, "0");
  const weekKey = `${now.getUTCFullYear()}-W${weekNum}`;
  const bookTitle = `Weekly Reading – ${now.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  })}`;

  const chapters: Array<{ title: string; byline: string; content: string }> =
    [];
  const allImages: import("./services/images.ts").EpubImage[] = [];

  for (const article of allArticles) {
    try {
      const { html: contentWithImages, images } = await processArticleImages(
        article.content,
        article.url,
        allImages.length,
      );
      allImages.push(...images);
      chapters.push({
        title: `${article.subTitle}: ${article.title}`,
        byline: article.byline || "Unknown Author",
        content: contentWithImages,
      });
    } catch (err) {
      console.error(
        `[weekly] Image processing failed for ${article.url}:`,
        err,
      );
      chapters.push({
        title: `${article.subTitle}: ${article.title}`,
        byline: article.byline || "Unknown Author",
        content: article.content,
      });
    }
  }

  if (chapters.length === 0) {
    console.log("[weekly] No articles processed successfully.");
    return;
  }

  const epubBytes = generateEpub(
    bookTitle,
    "Various Authors",
    chapters,
    allImages,
  );
  const meta: WeeklyBookMeta = {
    weekKey,
    kvKey: `weekly-book-data:${weekKey}`,
    title: bookTitle,
    createdAt: Date.now(),
    articleCount: chapters.length,
    size: epubBytes.byteLength,
  };

  await addWeeklyBook(env, meta, epubBytes);
  console.log(
    `[weekly] Generated "${bookTitle}" with ${chapters.length} chapters (${Math.round(epubBytes.byteLength / 1024)} KB).`,
  );
}

export default {
  fetch: app.fetch.bind(app),
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runWeeklyJob(env));
  },
};
