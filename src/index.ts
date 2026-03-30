import { Hono } from "hono";
import { extractArticle } from "./services/clean.ts";
import { generateEpub } from "./services/epub.ts";
import { processArticleImages } from "./services/images.ts";
import { urlToKey, getCached, putCached, putEpub, getEpub, type Env } from "./storage.ts";
import { renderUI } from "./ui.ts";

const app = new Hono<{ Bindings: Env }>();

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
    return renderUI({ error: "Invalid URL. Please enter a valid blog post URL." });
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
      return renderUI({ error: `Could not fetch that URL (HTTP ${resp.status}). Is it publicly accessible?` });
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

  const response = await getEpub(c.env, cached.kvKey, cached.title, cached.size);
  if (!response) {
    return c.html(
      `<html><body><p>EPUB not found. <a href="/">Convert again</a></p></body></html>`,
      404,
    );
  }
  return response;
});

export default app;
