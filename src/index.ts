import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { cors } from "hono/cors";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { AwsEnv } from "./repositories/types.ts";
import {
  DynamoSubscriptionRepo,
  DynamoArticleRepo,
  DynamoS3EpubRepo,
  DynamoUserRepo,
} from "./repositories/aws.ts";
import { BlogsService } from "./services/blogs.service.ts";
import { PostsService } from "./services/posts.service.ts";
import { ConversionService } from "./services/conversion.service.ts";
import { detectFeedUrl, fetchAndParseFeed } from "./services/rss.ts";
import { processArticleImages } from "./services/images.ts";
import { urlToKey } from "./utils.ts";
import { sendEpubEmail } from "./services/email.service.ts";
import { createLogger } from "./logger.ts";
import { proxiedFetch } from "./http/proxied-fetch.ts";
import { loadSecrets } from "./secrets.ts";
import { createAuthMiddleware } from "./middleware/auth.ts";
import type { AppVariables } from "./types/context.ts";

const sqsClient = new SQSClient({ region: process.env.AWS_REGION ?? "us-east-1" });

const logger = createLogger("api");

// ---------------------------------------------------------------------------
// Environment — read once at Lambda cold start
// ---------------------------------------------------------------------------

const env: AwsEnv = {
  DYNAMO_TABLE: process.env.DYNAMO_TABLE_NAME ?? "",
  S3_BUCKET: process.env.S3_BUCKET_NAME ?? "",
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  RESEND_FROM_ADDRESS: process.env.RESEND_FROM_ADDRESS,
  EMAIL_ALLOWLIST: process.env.EMAIL_ALLOWLIST,
};

async function ensureSecrets(): Promise<void> {
  await loadSecrets();
  env.RESEND_API_KEY = process.env.RESEND_API_KEY;
}

function defaultFetchHtml(url: string): Promise<string | null> {
  return proxiedFetch(url, { signal: AbortSignal.timeout(25000) })
    .then((resp) => (resp.ok ? resp.text() : null))
    .catch(() => null);
}

export function createServices(e: AwsEnv) {
  return {
    blogs: new BlogsService(new DynamoSubscriptionRepo(e), {
      detectFeedUrl,
      fetchAndParseFeed,
    }),
    posts: new PostsService(new DynamoArticleRepo(e), {
      fetch: defaultFetchHtml,
    }),
    conversion: new ConversionService(new DynamoS3EpubRepo(e), {
      processArticleImages,
    }),
  };
}

const app = new Hono<{ Variables: AppVariables }>();

app.use("*", cors({
  origin: ["https://blog-dl.pages.dev", "http://localhost:5173"],
}));

app.use("*", async (_c, next) => {
  await ensureSecrets();
  await next();
});

// Auth middleware — exempt only POST /register
const userRepo = new DynamoUserRepo(env);
const authMiddleware = createAuthMiddleware(userRepo);

app.use("*", async (c, next) => {
  if (c.req.method === "POST" && c.req.path === "/register") return next();
  return authMiddleware(c, next);
});

// ---------------------------------------------------------------------------
// Registration (public)
// ---------------------------------------------------------------------------

app.post("/register", async (c) => {
  let body: { name?: string; email?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body." }, 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  if (!name) return c.json({ error: "Please provide a name." }, 400);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: "Please provide a valid email address." }, 400);
  }

  const existing = await userRepo.getByEmail(email);
  if (existing) {
    return c.json({ error: "That email address is already registered." }, 409);
  }

  const user = {
    id: crypto.randomUUID(),
    name,
    email,
    apiKey: crypto.randomUUID(),
    approved: false,
    createdAt: Date.now(),
  };

  await userRepo.create(user);
  logger.info({ email }, "User registered, added to waitlist");

  return c.json({ message: "You have been added to the waitlist. You will be notified when your account is approved." }, 201);
});

// ---------------------------------------------------------------------------
// Single-article conversion
// ---------------------------------------------------------------------------

app.get("/", async (c) => {
  const { conversion } = createServices(env);
  const cachedArticles = await conversion.listCachedArticles();
  return c.json({ emailEnabled: !!env.RESEND_API_KEY, cachedArticles });
});

app.post("/convert", async (c) => {
  const emailEnabled = !!env.RESEND_API_KEY;
  let body: { url?: string; email?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body." }, 400);
  }

  const raw = body.url;
  if (!raw || typeof raw !== "string") {
    return c.json({ error: "Please provide a URL." }, 400);
  }

  let blogUrl: string;
  let emailAddress: string | null = null;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return c.json({ error: "Only http and https URLs are supported." }, 400);
    }
    blogUrl = parsed.href;
  } catch {
    return c.json({ error: "Invalid URL. Please enter a valid blog post URL." }, 400);
  }

  if (body.email && typeof body.email === "string" && body.email.trim()) {
    emailAddress = body.email.trim();
  }

  const { conversion } = createServices(env);

  logger.info({ url: blogUrl, hasEmail: !!emailAddress }, "Converting article");

  const cacheKey = await urlToKey(blogUrl);
  const cached = await conversion.getCachedConversion(cacheKey);
  if (cached) {
    logger.debug({ cacheKey, title: cached.title }, "Returning cached conversion");
    if (emailAddress && env.RESEND_API_KEY) {
      try {
        const buf = await conversion.getEpubData(cached.kvKey);
        if (buf) {
          const safeTitle = cached.title.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim() || "article";
          await sendEpubEmail({
            apiKey: env.RESEND_API_KEY,
            fromAddress: env.RESEND_FROM_ADDRESS ?? "",
            to: emailAddress,
            title: cached.title,
            filename: `${safeTitle}.epub`,
            epubBytes: new Uint8Array(buf),
          });
        }
        const shortKey = cacheKey.replace("epub:", "");
        return c.json({
          downloadUrl: `/download/${shortKey}`,
          downloadTitle: cached.title,
          emailSentTo: emailAddress,
        });
      } catch (err) {
        logger.error({ err, url: blogUrl }, "Failed to send email for cached conversion");
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ error: `Failed to send email: ${msg}` }, 500);
      }
    }
    const shortKey = cacheKey.replace("epub:", "");
    return c.json({ downloadUrl: `/download/${shortKey}`, downloadTitle: cached.title });
  }

  let html: string;
  try {
    const resp = await proxiedFetch(blogUrl, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      logger.warn({ url: blogUrl, status: resp.status }, "Failed to fetch article URL");
      return c.json(
        { error: `Could not fetch that URL (HTTP ${resp.status}). Is it publicly accessible?` },
        400,
      );
    }
    html = await resp.text();
  } catch (err) {
    logger.error({ err, url: blogUrl }, "Error fetching article URL");
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Failed to fetch the URL: ${msg}` }, 500);
  }

  try {
    const result = await conversion.convertSingleArticle(blogUrl, html);
    if (emailAddress && env.RESEND_API_KEY) {
      try {
        const safeTitle = result.title.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim() || "article";
        await sendEpubEmail({
          apiKey: env.RESEND_API_KEY,
          fromAddress: env.RESEND_FROM_ADDRESS ?? "",
          to: emailAddress,
          title: result.title,
          filename: `${safeTitle}.epub`,
          epubBytes: result.epubBytes,
        });
        const shortKey = result.cacheKey.replace("epub:", "");
        return c.json({
          downloadUrl: `/download/${shortKey}`,
          downloadTitle: result.title,
          emailSentTo: emailAddress,
        });
      } catch (err) {
        logger.error({ err, url: blogUrl }, "Failed to send email after conversion");
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ error: `Failed to send email: ${msg}` }, 500);
      }
    }
    const shortKey = result.cacheKey.replace("epub:", "");
    return c.json({ downloadUrl: `/download/${shortKey}`, downloadTitle: result.title });
  } catch (err) {
    logger.error({ err, url: blogUrl }, "Failed to convert article");
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Failed to convert article: ${msg}` }, 500);
  }
});

app.get("/download/:key", async (c) => {
  const key = c.req.param("key");
  if (!/^[a-f0-9]+$/.test(key)) return c.notFound();

  const { conversion } = createServices(env);
  const cached = await conversion.getCachedConversion(`epub:${key}`);
  if (!cached) {
    return c.json({ error: "EPUB not found or expired." }, 404);
  }

  const buf = await conversion.getEpubData(cached.kvKey);
  if (!buf) {
    return c.json({ error: "EPUB data not found." }, 404);
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

  const { posts, conversion } = createServices(env);
  const article = await posts.getArticle(id);
  if (!article) {
    return c.json({ error: "Article not found or expired." }, 404);
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
  const user = c.get("user");
  const { blogs } = createServices(env);
  const subscriptions = await blogs.listSubscriptions(user.id);
  return c.json({ subscriptions, emailEnabled: !!env.RESEND_API_KEY });
});

app.post("/subscriptions", async (c) => {
  let body: { url?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body." }, 400);
  }

  const raw = body.url;
  const user = c.get("user");
  const { blogs } = createServices(env);

  if (!raw || typeof raw !== "string") {
    return c.json({ error: "Please provide a URL." }, 400);
  }

  let siteUrl: string;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return c.json({ error: "Only http and https URLs are supported." }, 400);
    }
    siteUrl = parsed.href;
  } catch {
    return c.json({ error: "Invalid URL." }, 400);
  }

  const result = await blogs.subscribe(user.id, siteUrl);
  if ("error" in result) {
    return c.json({ error: result.error }, 400);
  }

  const fetchPostsQueueUrl = process.env.FETCH_POSTS_QUEUE_URL;
  if (fetchPostsQueueUrl) {
    await sqsClient.send(new SendMessageCommand({
      QueueUrl: fetchPostsQueueUrl,
      MessageBody: JSON.stringify({ subscriptionId: result.subscription.id, userId: user.id }),
    }));
  }

  return c.json(
    { subscription: result.subscription, message: `Subscribed to "${result.subscription.title}".` },
    201,
  );
});

app.post("/subscriptions/:id/delete", async (c) => {
  const id = c.req.param("id");
  if (!/^[a-f0-9]+$/.test(id)) return c.notFound();

  const user = c.get("user");
  const subsRepo = new DynamoSubscriptionRepo(env);
  const sub = await subsRepo.get(id);

  if (!sub) return c.json({ error: "Subscription not found." }, 404);
  if (sub.userId !== user.id) return c.json({ error: "Forbidden." }, 403);

  const { blogs } = createServices(env);
  await blogs.unsubscribe(id);
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// Weekly books
// ---------------------------------------------------------------------------

app.get("/weekly-books", async (c) => {
  const { conversion } = createServices(env);
  const books = await conversion.listWeeklyBooks();
  return c.json({ books, emailEnabled: !!env.RESEND_API_KEY });
});

app.get("/download/weekly/:weekKey", async (c) => {
  const weekKey = c.req.param("weekKey");
  if (!/^\d{4}-W\d{2}$/.test(weekKey)) return c.notFound();

  const { conversion } = createServices(env);
  const result = await conversion.getWeeklyBook(weekKey);
  if (!result) {
    return c.json({ error: "Weekly book not found or expired." }, 404);
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

  if (!env.RESEND_API_KEY) return c.json({ error: "Email delivery is not configured." }, 404);

  const { conversion, posts } = createServices(env);

  if (type === "weekly") {
    if (!/^\d{4}-W\d{2}$/.test(id)) return c.notFound();
    const books = await conversion.listWeeklyBooks();
    const book = books.find((b) => b.weekKey === id);
    if (!book) return c.json({ error: "Weekly book not found or expired." }, 404);
    return c.json({ epubType: "weekly", epubId: id, title: book.title });
  }

  if (type === "article") {
    if (!/^[a-f0-9]+$/.test(id)) return c.notFound();
    const article = await posts.getArticle(id);
    if (!article) return c.json({ error: "Article not found or expired." }, 404);
    return c.json({ epubType: "article", epubId: id, title: article.title });
  }

  if (type === "cached") {
    if (!/^[a-f0-9]+$/.test(id)) return c.notFound();
    const cached = await conversion.getCachedConversion(`epub:${id}`);
    if (!cached) return c.json({ error: "EPUB not found or expired." }, 404);
    return c.json({ epubType: "cached", epubId: id, title: cached.title });
  }

  return c.notFound();
});

app.post("/send-epub", async (c) => {
  let body: { email?: string; epub_type?: string; epub_id?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body." }, 400);
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const type = typeof body.epub_type === "string" ? body.epub_type : "";
  const id = typeof body.epub_id === "string" ? body.epub_id : "";

  if (!email) {
    return c.json({ error: "Please provide an email address." }, 400);
  }

  if (!env.RESEND_API_KEY) {
    return c.json({ error: "Email delivery is not configured." }, 503);
  }

  const { conversion, posts } = createServices(env);

  try {
    let epubBytes: Uint8Array;
    let title: string;
    let filename: string;

    if (type === "weekly") {
      if (!/^\d{4}-W\d{2}$/.test(id)) return c.json({ error: "Invalid ID." }, 400);
      const result = await conversion.getWeeklyBook(id);
      if (!result) return c.json({ error: "Weekly book not found or expired." }, 404);
      epubBytes = new Uint8Array(result.buf);
      title = result.meta.title;
      filename = `${result.meta.title.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim() || "weekly-reading"}.epub`;
    } else if (type === "article") {
      if (!/^[a-f0-9]+$/.test(id)) return c.json({ error: "Invalid ID." }, 400);
      const article = await posts.getArticle(id);
      if (!article) return c.json({ error: "Article not found or expired." }, 404);
      epubBytes = await conversion.convertArticleToEpub(article);
      title = article.title;
      filename = `${article.title.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim() || "article"}.epub`;
    } else if (type === "cached") {
      if (!/^[a-f0-9]+$/.test(id)) return c.json({ error: "Invalid ID." }, 400);
      const cached = await conversion.getCachedConversion(`epub:${id}`);
      if (!cached) return c.json({ error: "EPUB not found or expired." }, 404);
      const buf = await conversion.getEpubData(cached.kvKey);
      if (!buf) return c.json({ error: "EPUB data not found or expired." }, 404);
      epubBytes = new Uint8Array(buf);
      title = cached.title;
      filename = `${cached.title.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim() || "article"}.epub`;
    } else {
      return c.json({ error: "Invalid epub type." }, 400);
    }

    await sendEpubEmail({
      apiKey: env.RESEND_API_KEY,
      fromAddress: env.RESEND_FROM_ADDRESS ?? "",
      to: email,
      title,
      filename,
      epubBytes,
    });

    return c.json({ success: `EPUB sent to ${email}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Failed to send email: ${msg}` }, 500);
  }
});

// ---------------------------------------------------------------------------
// Lambda handler export
// ---------------------------------------------------------------------------

export const handler = handle(app);
