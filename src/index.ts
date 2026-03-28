import { extractArticle } from "./clean.ts";
import { generateEpub } from "./epub.ts";
import { urlToKey, getCached, putCached, putEpub, getEpub, type Env } from "./storage.ts";
import { renderUI } from "./ui.ts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // GET / — serve the UI
    if (request.method === "GET" && url.pathname === "/") {
      return renderUI();
    }

    // POST /convert — convert a blog URL to EPUB
    if (request.method === "POST" && url.pathname === "/convert") {
      return handleConvert(request, env);
    }

    // GET /download/:key — download a stored EPUB
    const downloadMatch = url.pathname.match(/^\/download\/([a-f0-9]+)$/);
    if (request.method === "GET" && downloadMatch) {
      return handleDownload(downloadMatch[1]!, env);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function handleConvert(request: Request, env: Env): Promise<Response> {
  let blogUrl: string;

  try {
    const body = await request.formData();
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

  // Check the KV cache first
  const cacheKey = await urlToKey(blogUrl);
  const cached = await getCached(env, cacheKey);
  if (cached) {
    return Response.redirect(`/download/${cacheKey.replace("epub:", "")}`, 303);
  }

  // Fetch the article with a 25s timeout
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

  // Extract article content
  let article: ReturnType<typeof extractArticle>;
  try {
    article = extractArticle(html, blogUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return renderUI({ error: `Could not extract article content: ${msg}` });
  }

  // Generate EPUB
  let epubBytes: Uint8Array;
  try {
    epubBytes = generateEpub(
      article.title || "Article",
      article.byline || "Unknown Author",
      [article],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return renderUI({ error: `Failed to generate EPUB: ${msg}` });
  }

  // Store in R2 and cache the key
  const r2Key = `${cacheKey.replace("epub:", "")}.epub`;
  await putEpub(env, r2Key, epubBytes, article.title || "Article");
  await putCached(env, cacheKey, {
    r2Key,
    title: article.title || "Article",
    createdAt: Date.now(),
  });

  return Response.redirect(`/download/${cacheKey.replace("epub:", "")}`, 303);
}

async function handleDownload(key: string, env: Env): Promise<Response> {
  const cacheKey = `epub:${key}`;
  const cached = await getCached(env, cacheKey);

  if (!cached) {
    // KV expired but user still has the link — try fetching directly from R2
    const r2Key = `${key}.epub`;
    const response = await getEpub(env, r2Key, "article");
    if (!response) {
      return new Response(
        `<html><body><p>EPUB not found or expired. <a href="/">Convert again</a></p></body></html>`,
        { status: 404, headers: { "Content-Type": "text/html" } },
      );
    }
    return response;
  }

  const response = await getEpub(env, cached.r2Key, cached.title);
  if (!response) {
    return new Response(
      `<html><body><p>EPUB not found. <a href="/">Convert again</a></p></body></html>`,
      { status: 404, headers: { "Content-Type": "text/html" } },
    );
  }
  return response;
}
