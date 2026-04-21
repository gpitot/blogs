import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { cors } from "hono/cors";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { AwsEnv } from "./repositories/types.ts";
import {
  DynamoFeedRepo,
  DynamoUserSubscriptionRepo,
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
import { hashPassword, verifyPassword } from "./services/password.ts";
import { createLogger } from "./logger.ts";
import { proxiedFetch } from "./http/proxied-fetch.ts";
import { loadSecrets } from "./secrets.ts";
import { createAuthMiddleware, AUTH_COOKIE } from "./middleware/auth.ts";
import type { AppVariables } from "./types/context.ts";
import { setCookie, deleteCookie } from "hono/cookie";

const sqsClient = new SQSClient({
  region: process.env.AWS_REGION ?? "us-east-1",
});

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
  const feedRepo = new DynamoFeedRepo(e);
  const userSubRepo = new DynamoUserSubscriptionRepo(e);
  return {
    blogs: new BlogsService(feedRepo, userSubRepo, {
      detectFeedUrl,
      fetchAndParseFeed,
    }),
    posts: new PostsService(new DynamoArticleRepo(e), {
      fetch: defaultFetchHtml,
    }),
    conversion: new ConversionService(new DynamoS3EpubRepo(e), {
      processArticleImages,
    }),
    feedRepo,
    userSubRepo,
  };
}

const app = new Hono<{ Variables: AppVariables }>();

app.use(
  "*",
  cors({
    origin: ["https://blog-dl.pages.dev", "http://localhost:5173"],
    credentials: true,
  }),
);

app.use("*", async (_c, next) => {
  await ensureSecrets();
  await next();
});

// Auth middleware — exempt public auth routes
const userRepo = new DynamoUserRepo(env);
const authMiddleware = createAuthMiddleware(userRepo);

const PUBLIC_ROUTES = new Set(["/register", "/login", "/logout"]);

app.use("*", async (c, next) => {
  if (PUBLIC_ROUTES.has(c.req.path)) return next();
  return authMiddleware(c, next);
});

// ---------------------------------------------------------------------------
// Registration (public)
// ---------------------------------------------------------------------------

app.post("/register", async (c) => {
  let body: { name?: string; email?: string; password?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body." }, 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!name) return c.json({ error: "Please provide a name." }, 400);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: "Please provide a valid email address." }, 400);
  }
  if (password.length < 8)
    return c.json({ error: "Password must be at least 8 characters." }, 400);

  const existing = await userRepo.getByEmail(email);
  if (existing) {
    return c.json({ error: "That email address is already registered." }, 409);
  }

  const passwordHash = await hashPassword(password);

  const user = {
    id: crypto.randomUUID(),
    name,
    email,
    apiKey: crypto.randomUUID(),
    passwordHash,
    approved: false,
    createdAt: Date.now(),
  };

  await userRepo.create(user);
  logger.info({ email }, "User registered, added to waitlist");

  return c.json(
    {
      message:
        "You have been added to the waitlist. You will be notified when your account is approved.",
    },
    201,
  );
});

app.post("/login", async (c) => {
  let body: { email?: string; password?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body." }, 400);
  }

  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || !password) {
    return c.json({ error: "Email and password are required." }, 400);
  }

  const user = await userRepo.getByEmail(email);
  const passwordOk = user
    ? await verifyPassword(password, user.passwordHash)
    : false;

  if (!user || !passwordOk) {
    return c.json({ error: "Invalid email or password." }, 401);
  }

  if (!user.approved) {
    return c.json({ error: "Your account is pending approval." }, 403);
  }

  setCookie(c, AUTH_COOKIE, user.apiKey, {
    httpOnly: true,
    sameSite: "None",
    secure: true,
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });

  logger.info({ email }, "User logged in");
  return c.json({ message: "Logged in successfully." });
});

app.post("/logout", (c) => {
  deleteCookie(c, AUTH_COOKIE, { path: "/" });
  return c.json({ message: "Logged out." });
});

// ---------------------------------------------------------------------------
// Single-article conversion
// ---------------------------------------------------------------------------

app.get("/", async (c) => {
  const user = c.get("user");
  const { conversion } = createServices(env);
  const cachedArticles = await conversion.listCachedArticles(user.id);
  return c.json({ cachedArticles });
});

app.post("/convert", async (c) => {
  if (!env.RESEND_API_KEY) {
    return c.json({ error: "Email delivery is not configured." }, 503);
  }

  let body: { url?: string };
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
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return c.json({ error: "Only http and https URLs are supported." }, 400);
    }
    blogUrl = parsed.href;
  } catch {
    return c.json(
      { error: "Invalid URL. Please enter a valid blog post URL." },
      400,
    );
  }

  const user = c.get("user");
  const { conversion } = createServices(env);

  logger.info({ url: blogUrl, email: user.email }, "Converting article");

  const cacheKey = await urlToKey(blogUrl);
  const cached = await conversion.getCachedConversion(cacheKey);
  if (cached) {
    logger.debug(
      { cacheKey, title: cached.title },
      "Returning cached conversion",
    );
    try {
      const buf = await conversion.getEpubData(cached.kvKey);
      if (buf) {
        const safeTitle =
          cached.title.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim() || "article";
        await sendEpubEmail({
          apiKey: env.RESEND_API_KEY,
          fromAddress: env.RESEND_FROM_ADDRESS ?? "",
          to: user.email,
          title: cached.title,
          filename: `${safeTitle}.epub`,
          epubBytes: new Uint8Array(buf),
        });
      }
      return c.json({ title: cached.title, emailSentTo: user.email });
    } catch (err) {
      logger.error(
        { err, url: blogUrl },
        "Failed to send email for cached conversion",
      );
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Failed to send email: ${msg}` }, 500);
    }
  }

  let html: string;
  try {
    const resp = await proxiedFetch(blogUrl, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      logger.warn(
        { url: blogUrl, status: resp.status },
        "Failed to fetch article URL",
      );
      return c.json(
        {
          error: `Could not fetch that URL (HTTP ${resp.status}). Is it publicly accessible?`,
        },
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
    const result = await conversion.convertSingleArticle(blogUrl, html, user.id);
    const safeTitle =
      result.title.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim() || "article";
    await sendEpubEmail({
      apiKey: env.RESEND_API_KEY,
      fromAddress: env.RESEND_FROM_ADDRESS ?? "",
      to: user.email,
      title: result.title,
      filename: `${safeTitle}.epub`,
      epubBytes: result.epubBytes,
    });
    return c.json({ title: result.title, emailSentTo: user.email });
  } catch (err) {
    logger.error({ err, url: blogUrl }, "Failed to convert article");
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Failed to convert article: ${msg}` }, 500);
  }
});

// ---------------------------------------------------------------------------
// Blog subscriptions
// ---------------------------------------------------------------------------

app.get("/subscriptions", async (c) => {
  const user = c.get("user");
  const { blogs } = createServices(env);
  const subscriptions = await blogs.listSubscriptions(user.id);
  return c.json({ subscriptions });
});

app.get("/subscriptions/popular", async (c) => {
  const { blogs } = createServices(env);
  const popular = await blogs.getPopularSubscriptions();
  return c.json({ popular });
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

  // Only trigger fetch if this is a new feed (no articles yet)
  if (result.subscription.convertedArticles.length === 0) {
    const fetchPostsQueueUrl = process.env.FETCH_POSTS_QUEUE_URL;
    if (fetchPostsQueueUrl) {
      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: fetchPostsQueueUrl,
          MessageBody: JSON.stringify({ feedId: result.subscription.feedId }),
        }),
      );
    }
  }

  return c.json(
    {
      subscription: result.subscription,
      message: `Subscribed to "${result.subscription.title}".`,
    },
    201,
  );
});

app.post("/subscriptions/:feedId/delete", async (c) => {
  const feedId = c.req.param("feedId");
  if (!/^[a-f0-9]+$/.test(feedId)) return c.notFound();

  const user = c.get("user");
  const { blogs, userSubRepo } = createServices(env);

  const isSubscribed = await userSubRepo.isSubscribed(user.id, feedId);
  if (!isSubscribed) return c.json({ error: "Subscription not found." }, 404);

  await blogs.unsubscribe(user.id, feedId);
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// Weekly books
// ---------------------------------------------------------------------------

app.get("/weekly-books", async (c) => {
  const user = c.get("user");
  const { conversion } = createServices(env);
  const books = await conversion.listWeeklyBooks(user.id);
  return c.json({ books });
});

// ---------------------------------------------------------------------------
// Email delivery
// ---------------------------------------------------------------------------

app.post("/send-epub", async (c) => {
  let body: { epub_type?: string; epub_id?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body." }, 400);
  }

  const user = c.get("user");
  const type = typeof body.epub_type === "string" ? body.epub_type : "";
  const id = typeof body.epub_id === "string" ? body.epub_id : "";

  if (!env.RESEND_API_KEY) {
    return c.json({ error: "Email delivery is not configured." }, 503);
  }

  const { conversion, posts } = createServices(env);

  try {
    let epubBytes: Uint8Array;
    let title: string;
    let filename: string;

    if (type === "weekly") {
      if (!/^\d{4}-W\d{2}$/.test(id))
        return c.json({ error: "Invalid ID." }, 400);
      const result = await conversion.getWeeklyBook(user.id, id);
      if (!result)
        return c.json({ error: "Weekly book not found or expired." }, 404);
      epubBytes = new Uint8Array(result.buf);
      title = result.meta.title;
      filename = `${result.meta.title.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim() || "weekly-reading"}.epub`;
    } else if (type === "article") {
      if (!/^[a-f0-9]+$/.test(id)) return c.json({ error: "Invalid ID." }, 400);
      const article = await posts.getArticle(id);
      if (!article)
        return c.json({ error: "Article not found or expired." }, 404);
      epubBytes = await conversion.convertArticleToEpub(article);
      title = article.title;
      filename = `${article.title.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim() || "article"}.epub`;
    } else if (type === "cached") {
      if (!/^[a-f0-9]+$/.test(id)) return c.json({ error: "Invalid ID." }, 400);
      const cached = await conversion.getCachedConversion(`epub:${id}`);
      if (!cached) return c.json({ error: "EPUB not found or expired." }, 404);
      const buf = await conversion.getEpubData(cached.kvKey);
      if (!buf)
        return c.json({ error: "EPUB data not found or expired." }, 404);
      epubBytes = new Uint8Array(buf);
      title = cached.title;
      filename = `${cached.title.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim() || "article"}.epub`;
    } else {
      return c.json({ error: "Invalid epub type." }, 400);
    }

    await sendEpubEmail({
      apiKey: env.RESEND_API_KEY,
      fromAddress: env.RESEND_FROM_ADDRESS ?? "",
      to: user.email,
      title,
      filename,
      epubBytes,
    });

    return c.json({ success: `EPUB sent to ${user.email}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Failed to send email: ${msg}` }, 500);
  }
});

// ---------------------------------------------------------------------------
// Lambda handler export
// ---------------------------------------------------------------------------

export const handler = handle(app);
