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
import { renderUI, renderSubscriptionsUI, renderWeeklyBooksUI, renderEmailFormUI } from "./ui.ts";
import { sendEpubEmail, isEmailAllowed } from "./services/email.service.ts";

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
  return renderUI({ emailEnabled: !!c.env.RESEND_API_KEY });
});

app.post("/convert", async (c) => {
  const emailEnabled = !!c.env.RESEND_API_KEY;
  let blogUrl: string;
  let emailAddress: string | null = null;
  try {
    const body = await c.req.formData();
    const raw = body.get("url");
    if (!raw || typeof raw !== "string") {
      return renderUI({ error: "Please provide a URL.", emailEnabled });
    }
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return renderUI({ error: "Only http and https URLs are supported.", emailEnabled });
    }
    blogUrl = parsed.href;
    const rawEmail = body.get("email");
    if (rawEmail && typeof rawEmail === "string" && rawEmail.trim()) {
      emailAddress = rawEmail.trim();
      if (!isEmailAllowed(emailAddress, c.env.EMAIL_ALLOWLIST)) {
        return renderUI({
          error: "That email address is not on the allow list.",
          emailEnabled,
        });
      }
    }
  } catch {
    return renderUI({
      error: "Invalid URL. Please enter a valid blog post URL.",
      emailEnabled,
    });
  }

  const { conversion } = createServices(c.env);

  const cacheKey = await urlToKey(blogUrl);
  const cached = await conversion.getCachedConversion(cacheKey);
  if (cached) {
    if (emailAddress && c.env.RESEND_API_KEY) {
      try {
        const buf = await conversion.getEpubData(cached.kvKey);
        if (buf) {
          const safeTitle = cached.title.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim() || "article";
          await sendEpubEmail({
            apiKey: c.env.RESEND_API_KEY,
            fromAddress: c.env.RESEND_FROM_ADDRESS,
            to: emailAddress,
            title: cached.title,
            filename: `${safeTitle}.epub`,
            epubBytes: new Uint8Array(buf),
          });
        }
        const shortKey = cacheKey.replace("epub:", "");
        return renderUI({
          emailEnabled,
          emailSentTo: emailAddress,
          downloadUrl: `/download/${shortKey}`,
          downloadTitle: cached.title,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return renderUI({ error: `Failed to send email: ${msg}`, emailEnabled });
      }
    }
    return c.redirect(`/download/${cacheKey.replace("epub:", "")}`, 303);
  }

  let html: string;
  try {
    const resp = await fetch(blogUrl, {
      signal: AbortSignal.timeout(5000),
      headers: FETCH_HEADERS,
    });
    console.log('Fetch response status:', resp);
    if (!resp.ok) {
      return renderUI({
        error: `Could not fetch that URL (HTTP ${resp.status}). Is it publicly accessible?`,
        emailEnabled,
      });
    }
    html = await resp.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log('Fetch error:', err);
    return renderUI({ error: `Failed to fetch the URL: ${msg}`, emailEnabled });
  }

  try {
    const result = await conversion.convertSingleArticle(blogUrl, html);
    if (emailAddress && c.env.RESEND_API_KEY) {
      try {
        const safeTitle = result.title.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim() || "article";
        await sendEpubEmail({
          apiKey: c.env.RESEND_API_KEY,
          fromAddress: c.env.RESEND_FROM_ADDRESS,
          to: emailAddress,
          title: result.title,
          filename: `${safeTitle}.epub`,
          epubBytes: result.epubBytes,
        });
        const shortKey = result.cacheKey.replace("epub:", "");
        return renderUI({
          emailEnabled,
          emailSentTo: emailAddress,
          downloadUrl: `/download/${shortKey}`,
          downloadTitle: result.title,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return renderUI({ error: `Failed to send email: ${msg}`, emailEnabled });
      }
    }
    return c.redirect(
      `/download/${result.cacheKey.replace("epub:", "")}`,
      303,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log('Conversion error:', msg);
    return renderUI({ error: `Failed to convert article: ${msg}`, emailEnabled });
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
  return renderSubscriptionsUI(subs, { emailEnabled: !!c.env.RESEND_API_KEY });
});

app.post("/subscriptions", async (c) => {
  const body = await c.req.formData();
  const raw = body.get("url");
  const emailEnabled = !!c.env.RESEND_API_KEY;

  const { blogs } = createServices(c.env);

  if (!raw || typeof raw !== "string") {
    const subs = await blogs.listSubscriptions();
    return renderSubscriptionsUI(subs, { error: "Please provide a URL.", emailEnabled });
  }

  let siteUrl: string;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      const subs = await blogs.listSubscriptions();
      return renderSubscriptionsUI(subs, {
        error: "Only http and https URLs are supported.",
        emailEnabled,
      });
    }
    siteUrl = parsed.href;
  } catch {
    const subs = await blogs.listSubscriptions();
    return renderSubscriptionsUI(subs, { error: "Invalid URL.", emailEnabled });
  }

  const result = await blogs.subscribe(siteUrl);
  const subs = await blogs.listSubscriptions();

  if ("error" in result) {
    return renderSubscriptionsUI(subs, { error: result.error, emailEnabled });
  }

  return renderSubscriptionsUI(subs, {
    success: `Subscribed to "${result.subscription.title}". New posts will appear in your weekly book.`,
    emailEnabled,
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
  return renderWeeklyBooksUI(books, { emailEnabled: !!c.env.RESEND_API_KEY });
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
// Email delivery
// ---------------------------------------------------------------------------

app.get("/email/:type/:id", async (c) => {
  const type = c.req.param("type");
  const id = c.req.param("id");

  if (!c.env.RESEND_API_KEY) return c.notFound();

  const { conversion, posts } = createServices(c.env);

  if (type === "weekly") {
    if (!/^\d{4}-W\d{2}$/.test(id)) return c.notFound();
    const books = await conversion.listWeeklyBooks();
    const book = books.find((b) => b.weekKey === id);
    if (!book) {
      return c.html(
        `<html><body><p>Weekly book not found or expired. <a href="/weekly-books">View all books</a></p></body></html>`,
        404,
      );
    }
    return renderEmailFormUI({ epubType: "weekly", epubId: id, title: book.title, backUrl: "/weekly-books" });
  }

  if (type === "article") {
    if (!/^[a-f0-9]+$/.test(id)) return c.notFound();
    const article = await posts.getArticle(id);
    if (!article) {
      return c.html(
        `<html><body><p>Article not found or expired. <a href="/subscriptions">View subscriptions</a></p></body></html>`,
        404,
      );
    }
    return renderEmailFormUI({ epubType: "article", epubId: id, title: article.title, backUrl: "/subscriptions" });
  }

  return c.notFound();
});

app.post("/send-epub", async (c) => {
  const body = await c.req.formData();
  const emailRaw = body.get("email");
  const epubType = body.get("epub_type");
  const epubId = body.get("epub_id");

  const email = typeof emailRaw === "string" ? emailRaw.trim() : "";
  const type = typeof epubType === "string" ? epubType : "";
  const id = typeof epubId === "string" ? epubId : "";

  const makeFormPage = (opts: { error?: string; success?: string }) =>
    renderEmailFormUI({
      epubType: type,
      epubId: id,
      title: "",
      backUrl: type === "weekly" ? "/weekly-books" : "/subscriptions",
      email,
      ...opts,
    });

  if (!email) {
    return makeFormPage({ error: "Please provide an email address." });
  }

  if (!c.env.RESEND_API_KEY) {
    return makeFormPage({ error: "Email delivery is not configured." });
  }

  if (!isEmailAllowed(email, c.env.EMAIL_ALLOWLIST)) {
    return makeFormPage({ error: "That email address is not on the allow list." });
  }

  const { conversion, posts } = createServices(c.env);

  try {
    let epubBytes: Uint8Array;
    let title: string;
    let filename: string;

    if (type === "weekly") {
      if (!/^\d{4}-W\d{2}$/.test(id)) return c.notFound();
      const result = await conversion.getWeeklyBook(id);
      if (!result) return makeFormPage({ error: "Weekly book not found or expired." });
      epubBytes = new Uint8Array(result.buf);
      title = result.meta.title;
      filename = `${result.meta.title.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim() || "weekly-reading"}.epub`;
    } else if (type === "article") {
      if (!/^[a-f0-9]+$/.test(id)) return c.notFound();
      const article = await posts.getArticle(id);
      if (!article) return makeFormPage({ error: "Article not found or expired." });
      epubBytes = await conversion.convertArticleToEpub(article);
      title = article.title;
      filename = `${article.title.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim() || "article"}.epub`;
    } else {
      return c.notFound();
    }

    await sendEpubEmail({
      apiKey: c.env.RESEND_API_KEY,
      fromAddress: c.env.RESEND_FROM_ADDRESS,
      to: email,
      title,
      filename,
      epubBytes,
    });

    return renderEmailFormUI({
      epubType: type,
      epubId: id,
      title,
      backUrl: type === "weekly" ? "/weekly-books" : "/subscriptions",
      success: `EPUB sent to ${email}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return makeFormPage({ error: `Failed to send email: ${msg}` });
  }
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
