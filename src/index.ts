import { Hono } from "hono";
import { extractArticle } from "./services/clean.ts";
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
  MAX_SEEN_GUIDS,
  MAX_RECENT_EPUBS,
  type Env,
  type Subscription,
} from "./storage.ts";
import { renderUI, renderSubscriptionsUI } from "./ui.ts";

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Existing single-article conversion
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

  // Download and process images for offline reading
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
    recentEpubs: [],
  };

  await putSubscription(c.env, sub);

  const subs = await listSubscriptions(c.env);
  return renderSubscriptionsUI(subs, {
    success: `Subscribed to "${sub.title}". New posts will be automatically converted to EPUB.`,
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
// Scheduled handler – checks all subscriptions for new posts
// ---------------------------------------------------------------------------

async function convertArticleToEpub(
  env: Env,
  item: FeedItem,
): Promise<string | null> {
  const cacheKey = await urlToKey(item.link);

  const cached = await getCached(env, cacheKey);
  if (cached) {
    return cacheKey.replace("epub:", "");
  }

  const resp = await fetch(item.link, {
    signal: AbortSignal.timeout(25000),
    headers: { "User-Agent": "Mozilla/5.0 (compatible; BlogToEpub/1.0)" },
  });
  if (!resp.ok) {
    console.log(`Failed to fetch article ${item.link}: HTTP ${resp.status}`);
    return null;
  }

  const html = await resp.text();
  const article = extractArticle(html, item.link);

  const { html: contentWithImages, images } = await processArticleImages(
    article.content,
    item.link,
  );
  article.content = contentWithImages;

  const epubBytes = generateEpub(
    article.title || item.title || "Article",
    article.byline || "Unknown Author",
    [article],
    images,
  );

  const kvKey = `epub-data:${cacheKey.replace("epub:", "")}`;
  await putEpub(env, kvKey, epubBytes);
  await putCached(env, cacheKey, {
    kvKey,
    title: article.title || item.title || "Article",
    createdAt: Date.now(),
    size: epubBytes.byteLength,
  });

  return cacheKey.replace("epub:", "");
}

async function checkSubscription(env: Env, sub: Subscription): Promise<void> {
  const feed = await fetchAndParseFeed(sub.feedUrl);

  const seenSet = new Set(sub.seenGuids);
  // Only process items we haven't seen yet, newest first, up to 5
  const newItems = feed.items
    .filter((item) => !seenSet.has(item.guid))
    .sort((a, b) => b.pubDate - a.pubDate)
    .slice(0, 5);

  const newEpubs: Subscription["recentEpubs"] = [];
  const newGuids: string[] = [];

  for (const item of newItems) {
    newGuids.push(item.guid);
    try {
      const key = await convertArticleToEpub(env, item);
      if (key) {
        newEpubs.push({
          key,
          title: item.title || item.link,
          createdAt: Date.now(),
        });
      }
    } catch (err) {
      console.error(`[subscriptions] Failed to convert ${item.link}:`, err);
    }
  }

  const allGuids = [...newGuids, ...sub.seenGuids].slice(0, MAX_SEEN_GUIDS);
  const allEpubs = [...newEpubs, ...sub.recentEpubs].slice(0, MAX_RECENT_EPUBS);
  console.log(
    `[subscriptions] Checked "${sub.title}": ${newGuids.length} new items, ${newEpubs.length} new EPUBs.`,
  );
  await putSubscription(env, {
    ...sub,
    lastChecked: Date.now(),
    seenGuids: allGuids,
    recentEpubs: allEpubs,
  });
}

async function checkAllSubscriptions(env: Env): Promise<void> {
  console.log(`[subscriptions] Checking for new posts...`);
  const subs = await listSubscriptions(env);
  for (const sub of subs) {
    try {
      await checkSubscription(env, sub);
    } catch (err) {
      console.error(
        `[subscriptions] Error checking subscription ${sub.id} (${sub.feedUrl}):`,
        err,
      );
    }
  }
}

export default {
  fetch: app.fetch.bind(app),
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(checkAllSubscriptions(env));
  },
};
