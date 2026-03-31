import { Hono } from "hono";
import type { Env } from "./repositories/types.ts";
import {
  KvSubscriptionRepo,
  KvArticleRepo,
  KvEpubRepo,
} from "./repositories/kv.ts";
import { BlogsService } from "./services/blogs.service.ts";
import { PostsService } from "./services/posts.service.ts";
import { ConversionService } from "./services/conversion.service.ts";
import { detectFeedUrl, fetchAndParseFeed } from "./services/rss.ts";
import { processArticleImages } from "./services/images.ts";
import { urlToKey } from "./utils.ts";
import { renderUI, renderSubscriptionsUI, renderWeeklyBooksUI } from "./ui.ts";

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; BlogToEpub/1.0)",
};

function defaultFetchHtml(url: string): Promise<string | null> {
  return fetch(url, {
    signal: AbortSignal.timeout(25000),
    headers: FETCH_HEADERS,
  })
    .then((resp) => (resp.ok ? resp.text() : null))
    .catch(() => null);
}

function createServices(env: Env) {
  const kv = env.EPUB_CACHE;
  return {
    blogs: new BlogsService(new KvSubscriptionRepo(kv), {
      detectFeedUrl,
      fetchAndParseFeed,
    }),
    posts: new PostsService(new KvArticleRepo(kv), {
      fetch: defaultFetchHtml,
    }),
    conversion: new ConversionService(new KvEpubRepo(kv), {
      processArticleImages,
    }),
  };
}

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Single-article conversion
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

  const { conversion } = createServices(c.env);

  const cacheKey = await urlToKey(blogUrl);
  const cached = await conversion.getCachedConversion(cacheKey);
  if (cached) {
    return c.redirect(`/download/${cacheKey.replace("epub:", "")}`, 303);
  }

  let html: string;
  try {
    const resp = await fetch(blogUrl, {
      signal: AbortSignal.timeout(25000),
      headers: FETCH_HEADERS,
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

  try {
    const result = await conversion.convertSingleArticle(blogUrl, html);
    return c.redirect(
      `/download/${result.cacheKey.replace("epub:", "")}`,
      303,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return renderUI({ error: `Failed to convert article: ${msg}` });
  }
});

app.get("/download/:key", async (c) => {
  const key = c.req.param("key");
  if (!/^[a-f0-9]+$/.test(key)) return c.notFound();

  const { conversion } = createServices(c.env);
  const cached = await conversion.getCachedConversion(`epub:${key}`);
  if (!cached) {
    return c.html(
      `<html><body><p>EPUB not found or expired. <a href="/">Convert again</a></p></body></html>`,
      404,
    );
  }

  const buf = await conversion.getEpubData(cached.kvKey);
  if (!buf) {
    return c.html(
      `<html><body><p>EPUB not found. <a href="/">Convert again</a></p></body></html>`,
      404,
    );
  }

  const safeTitle =
    cached.title.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim() || "article";
  return new Response(buf, {
    headers: {
      "Content-Type": "application/epub+zip",
      "Content-Disposition": `attachment; filename="${safeTitle}.epub"`,
      "Content-Length": cached.size.toString(),
      "Cache-Control": "public, max-age=604800",
    },
  });
});

// ---------------------------------------------------------------------------
// Per-article download (subscription articles)
// ---------------------------------------------------------------------------

app.get("/download/article/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[a-f0-9]+$/.test(id)) return c.notFound();

  const { posts, conversion } = createServices(c.env);
  const article = await posts.getArticle(id);
  if (!article) {
    return c.html(
      `<html><body><p>Article not found or expired. <a href="/subscriptions">View subscriptions</a></p></body></html>`,
      404,
    );
  }

  const epubBytes = await conversion.convertArticleToEpub(article);
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
  const { blogs } = createServices(c.env);
  const subs = await blogs.listSubscriptions();
  return renderSubscriptionsUI(subs);
});

app.post("/subscriptions", async (c) => {
  const body = await c.req.formData();
  const raw = body.get("url");

  const { blogs } = createServices(c.env);

  if (!raw || typeof raw !== "string") {
    const subs = await blogs.listSubscriptions();
    return renderSubscriptionsUI(subs, { error: "Please provide a URL." });
  }

  let siteUrl: string;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      const subs = await blogs.listSubscriptions();
      return renderSubscriptionsUI(subs, {
        error: "Only http and https URLs are supported.",
      });
    }
    siteUrl = parsed.href;
  } catch {
    const subs = await blogs.listSubscriptions();
    return renderSubscriptionsUI(subs, { error: "Invalid URL." });
  }

  const result = await blogs.subscribe(siteUrl);
  const subs = await blogs.listSubscriptions();

  if ("error" in result) {
    return renderSubscriptionsUI(subs, { error: result.error });
  }

  return renderSubscriptionsUI(subs, {
    success: `Subscribed to "${result.subscription.title}". New posts will appear in your weekly book.`,
  });
});

app.post("/subscriptions/:id/delete", async (c) => {
  const id = c.req.param("id");
  if (!/^[a-f0-9]+$/.test(id)) return c.notFound();
  const { blogs } = createServices(c.env);
  await blogs.unsubscribe(id);
  return c.redirect("/subscriptions", 303);
});

// ---------------------------------------------------------------------------
// Weekly books
// ---------------------------------------------------------------------------

app.get("/weekly-books", async (c) => {
  const { conversion } = createServices(c.env);
  const books = await conversion.listWeeklyBooks();
  return renderWeeklyBooksUI(books);
});

app.get("/download/weekly/:weekKey", async (c) => {
  const weekKey = c.req.param("weekKey");
  if (!/^\d{4}-W\d{2}$/.test(weekKey)) return c.notFound();

  const { conversion } = createServices(c.env);
  const result = await conversion.getWeeklyBook(weekKey);
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

async function runWeeklyJob(env: Env): Promise<void> {
  console.log("[weekly] Checking subscriptions and compiling book...");
  const { blogs, posts, conversion } = createServices(env);
  const subs = await blogs.listSubscriptions();

  const allArticles: import("./repositories/types.ts").PendingArticle[] = [];

  for (const sub of subs) {
    try {
      const newItems = await blogs.checkForNewPosts(sub);
      const saved: import("./repositories/types.ts").PendingArticle[] = [];

      for (const item of newItems) {
        try {
          const article = await posts.fetchAndSave(item, sub.id, sub.title);
          if (article) {
            saved.push(article);
            allArticles.push(article);
          }
        } catch (err) {
          console.error(`[weekly] Failed to save ${item.link}:`, err);
        }
      }

      if (saved.length > 0) {
        await blogs.updateRecentArticles(sub, saved);
      }

      console.log(
        `[weekly] "${sub.title}": ${saved.length} new articles saved.`,
      );
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

  console.log(
    `[weekly] Compiling ${allArticles.length} articles into book...`,
  );
  await conversion.compileWeeklyBook(allArticles);
}

export default {
  fetch: app.fetch.bind(app),
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runWeeklyJob(env));
  },
};
