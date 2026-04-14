import { Hono } from "hono";
import type { Env, JobMeta } from "./repositories/types.ts";
import {
  KvSubscriptionRepo,
  KvArticleRepo,
  KvEpubRepo,
  KvJobRepo,
} from "./repositories/kv.ts";
import { BlogsService } from "./services/blogs.service.ts";
import { PostsService } from "./services/posts.service.ts";
import { ConversionService } from "./services/conversion.service.ts";
import { detectFeedUrl, fetchAndParseFeed } from "./services/rss.ts";
import { processArticleImages } from "./services/images.ts";
import { urlToKey, generateId } from "./utils.ts";
import {
  renderUI,
  renderSubscriptionsUI,
  renderWeeklyBooksUI,
  renderEmailFormUI,
} from "./ui.ts";
import { sendEpubEmail, isEmailAllowed } from "./services/email.service.ts";
import { handleQueueBatch } from "./queue/handler.ts";
import type {
  ParseArticleMsg,
  AssembleEpubMsg,
  CheckFeedMsg,
} from "./queue/types.ts";

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

app.get("/", async (c) => {
  const { conversion } = createServices(c.env);
  const cachedArticles = await conversion.listCachedArticles();
  return renderUI({ emailEnabled: !!c.env.RESEND_API_KEY, cachedArticles });
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
      return renderUI({
        error: "Only http and https URLs are supported.",
        emailEnabled,
      });
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

  // Fast path: already cached — deliver immediately
  const cacheKey = await urlToKey(blogUrl);
  const cached = await conversion.getCachedConversion(cacheKey);
  if (cached) {
    if (emailAddress && c.env.RESEND_API_KEY) {
      try {
        const buf = await conversion.getEpubData(cached.kvKey);
        if (buf) {
          const safeTitle =
            cached.title.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim() || "article";
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
        return renderUI({
          error: `Failed to send email: ${msg}`,
          emailEnabled,
        });
      }
    }
    return c.redirect(`/download/${cacheKey.replace("epub:", "")}`, 303);
  }

  // Queue the work so CPU-heavy steps each get their own 10ms budget
  const jobId = generateId();
  const now = Date.now();
  const jobs = new KvJobRepo(c.env.EPUB_CACHE);
  const job: JobMeta = {
    jobId,
    url: blogUrl,
    status: "queued",
    emailTo: emailAddress,
    createdAt: now,
    updatedAt: now,
  };
  await jobs.putJob(job);

  const parseMsg: ParseArticleMsg = {
    jobId,
    url: blogUrl,
    mode: "single",
    emailTo: emailAddress,
  };
  try {
    await c.env.Q_PARSE_ARTICLE.send(parseMsg);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return renderUI({
      error: `Failed to queue conversion: ${msg}`,
      emailEnabled,
    });
  }

  return c.redirect(`/status/${jobId}`, 303);
});

// ---------------------------------------------------------------------------
// Job status polling
// ---------------------------------------------------------------------------

app.get("/status/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  if (!/^[a-f0-9]+$/.test(jobId)) return c.notFound();

  const jobs = new KvJobRepo(c.env.EPUB_CACHE);
  const job = await jobs.getJob(jobId);
  if (!job) {
    return c.html(
      `<html><body><p>Job not found or expired. <a href="/">Convert again</a></p></body></html>`,
      404,
    );
  }

  if (job.status === "done" && job.cacheKey) {
    return c.redirect(`/download/${job.cacheKey.replace("epub:", "")}`, 303);
  }

  if (job.status === "error") {
    return c.html(
      `<html><body><h2>Conversion failed</h2><p>${escapeHtml(job.error ?? "Unknown error")}</p><p><a href="/">Try again</a></p></body></html>`,
      500,
    );
  }

  const label: Record<JobMeta["status"], string> = {
    queued: "Queued…",
    parsing: "Fetching & extracting article…",
    "processing-images": "Processing images…",
    assembling: "Assembling EPUB…",
    done: "Done",
    error: "Error",
  };

  return c.html(
    `<html>
      <head>
        <meta http-equiv="refresh" content="3;url=/status/${jobId}" />
        <title>Converting…</title>
        <style>body{font-family:system-ui,sans-serif;max-width:640px;margin:5rem auto;padding:0 1.25rem;color:#1a1a1a;background:#fafafa}</style>
      </head>
      <body>
        <h1>Converting…</h1>
        <p>${escapeHtml(label[job.status])}</p>
        <p><small>${escapeHtml(job.url)}</small></p>
        <p><small>This page refreshes every 3 seconds.</small></p>
      </body>
    </html>`,
  );
});

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

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
    return renderSubscriptionsUI(subs, {
      error: "Please provide a URL.",
      emailEnabled,
    });
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
    return renderEmailFormUI({
      epubType: "weekly",
      epubId: id,
      title: book.title,
      backUrl: "/weekly-books",
    });
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
    return renderEmailFormUI({
      epubType: "article",
      epubId: id,
      title: article.title,
      backUrl: "/subscriptions",
    });
  }

  if (type === "cached") {
    if (!/^[a-f0-9]+$/.test(id)) return c.notFound();
    const cached = await conversion.getCachedConversion(`epub:${id}`);
    if (!cached) {
      return c.html(
        `<html><body><p>EPUB not found or expired. <a href="/">Convert again</a></p></body></html>`,
        404,
      );
    }
    return renderEmailFormUI({
      epubType: "cached",
      epubId: id,
      title: cached.title,
      backUrl: "/",
    });
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
      backUrl:
        type === "weekly"
          ? "/weekly-books"
          : type === "cached"
            ? "/"
            : "/subscriptions",
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
    return makeFormPage({
      error: "That email address is not on the allow list.",
    });
  }

  const { conversion, posts } = createServices(c.env);

  try {
    let epubBytes: Uint8Array;
    let title: string;
    let filename: string;

    if (type === "weekly") {
      if (!/^\d{4}-W\d{2}$/.test(id)) return c.notFound();
      const result = await conversion.getWeeklyBook(id);
      if (!result)
        return makeFormPage({ error: "Weekly book not found or expired." });
      epubBytes = new Uint8Array(result.buf);
      title = result.meta.title;
      filename = `${result.meta.title.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim() || "weekly-reading"}.epub`;
    } else if (type === "article") {
      if (!/^[a-f0-9]+$/.test(id)) return c.notFound();
      const article = await posts.getArticle(id);
      if (!article)
        return makeFormPage({ error: "Article not found or expired." });
      epubBytes = await conversion.convertArticleToEpub(article);
      title = article.title;
      filename = `${article.title.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim() || "article"}.epub`;
    } else if (type === "cached") {
      if (!/^[a-f0-9]+$/.test(id)) return c.notFound();
      const cached = await conversion.getCachedConversion(`epub:${id}`);
      if (!cached) return makeFormPage({ error: "EPUB not found or expired." });
      const buf = await conversion.getEpubData(cached.kvKey);
      if (!buf)
        return makeFormPage({ error: "EPUB data not found or expired." });
      epubBytes = new Uint8Array(buf);
      title = cached.title;
      filename = `${cached.title.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim() || "article"}.epub`;
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
      backUrl:
        type === "weekly"
          ? "/weekly-books"
          : type === "cached"
            ? "/"
            : "/subscriptions",
      success: `EPUB sent to ${email}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return makeFormPage({ error: `Failed to send email: ${msg}` });
  }
});

// ---------------------------------------------------------------------------
// Admin / local-testing triggers
// ---------------------------------------------------------------------------

function checkAdminSecret(c: {
  req: { header: (name: string) => string | undefined };
  env: Env;
}): Response | null {
  const expected = c.env.ADMIN_SECRET;
  if (!expected) return new Response("Admin disabled: ADMIN_SECRET not set.\n", { status: 503 });
  const provided = c.req.header("x-admin-secret");
  if (provided !== expected) return new Response("Unauthorized.\n", { status: 401 });
  return null;
}

app.post("/admin/assemble-weekly/:weekKey?", async (c) => {
  const unauth = checkAdminSecret(c);
  if (unauth) return unauth;

  const paramWeekKey = c.req.param("weekKey");
  const weekKey =
    paramWeekKey ??
    (() => {
      const now = new Date();
      const w = getISOWeekNumber(now).toString().padStart(2, "0");
      return `${now.getUTCFullYear()}-W${w}`;
    })();
  if (!/^\d{4}-W\d{2}$/.test(weekKey)) {
    return c.text("Invalid weekKey. Expected YYYY-Www.", 400);
  }
  const msg: AssembleEpubMsg = { kind: "weekly", weekKey };
  await c.env.Q_ASSEMBLE_EPUB.send(msg);
  return c.text(`Enqueued assemble-weekly for ${weekKey}\n`);
});

app.post("/admin/run-cron", async (c) => {
  const unauth = checkAdminSecret(c);
  if (unauth) return unauth;

  c.executionCtx.waitUntil(runWeeklyJob(c.env));
  return c.text("Cron job enqueued.\n");
});

// ---------------------------------------------------------------------------
// Scheduled handler
// ---------------------------------------------------------------------------

/**
 * Weekly cron fans work out onto queues:
 *   - enqueue one check-feed per subscription (each consumer invocation parses
 *     the RSS and enqueues parse-article jobs for new items)
 *   - enqueue a single delayed assemble-epub (kind: "weekly") for +6h, by which
 *     time per-article jobs should have run and their images downloaded
 */
async function runWeeklyJob(env: Env): Promise<void> {
  console.log("[weekly] Enqueuing subscription checks...");
  const subs = new KvSubscriptionRepo(env.EPUB_CACHE);
  const ids = (await subs.list()).map((s) => s.id);

  const now = new Date();
  const weekNum = getISOWeekNumber(now).toString().padStart(2, "0");
  const weekKey = `${now.getUTCFullYear()}-W${weekNum}`;

  for (const id of ids) {
    const msg: CheckFeedMsg = { subId: id, weekKey };
    try {
      await env.Q_CHECK_FEED.send(msg);
    } catch (err) {
      console.error(`[weekly] Failed to enqueue check-feed for ${id}:`, err);
    }
  }

  const assembleMsg: AssembleEpubMsg = { kind: "weekly", weekKey };
  const DELAY_TIME = 60 * 60;
  try {
    await env.Q_ASSEMBLE_EPUB.send(assembleMsg, { delaySeconds: DELAY_TIME });
  } catch (err) {
    console.error(`[weekly] Failed to enqueue assemble-weekly:`, err);
  }

  console.log(
    `[weekly] enqueued ${ids.length} check-feed + assemble-weekly for ${weekKey}.`,
  );
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

export default {
  fetch: app.fetch.bind(app),
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runWeeklyJob(env));
  },
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await handleQueueBatch(batch as MessageBatch<never>, env);
  },
};
