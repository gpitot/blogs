import type { Env } from "../repositories/types.ts";
import type { ParseArticleMsg, ProcessImageMsg, AssembleEpubMsg } from "./types.ts";
import { KvJobRepo } from "../repositories/kv.ts";
import { extractArticle, extractArticleFromFeedContent, extractCanonicalUrl } from "../services/clean.ts";
import { extractImageUrls } from "../services/images.ts";

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; BlogToEpub/1.0)",
};

const ASSEMBLE_DELAY_SECONDS = 20;

/**
 * Parse-article consumer. Runs in its own 10ms CPU budget:
 * - fetch HTML (I/O, doesn't count)
 * - Readability + sanitize (CPU-heavy, this is the main cost)
 * - rewrite <img> srcs to placeholders, collect absolute URLs
 * - persist ArticleMeta to KV
 * - fan out one `process-image` message per image URL
 * - enqueue `assemble-epub` with a small delay so images have time to land
 */
export async function handleParseArticle(msg: ParseArticleMsg, env: Env): Promise<void> {
  const jobs = new KvJobRepo(env.EPUB_CACHE);

  // Mark job as parsing (single-flow only tracks status; weekly flow is fire-and-forget)
  if (msg.mode === "single") {
    const job = await jobs.getJob(msg.jobId);
    if (job) {
      job.status = "parsing";
      job.updatedAt = Date.now();
      await jobs.putJob(job);
    }
  }

  let article: { title: string; content: string; byline: string } | null = null;
  let articleUrl = msg.url;

  // Prefer feed-provided content when substantial — avoids a fetch and avoids Readability
  if (msg.feedContent && msg.feedContent.length >= 500 && msg.feedTitle) {
    article = extractArticleFromFeedContent(msg.feedContent, msg.feedTitle, msg.url);
  } else {
    let html: string | null = null;
    try {
      const resp = await fetch(msg.url, {
        signal: AbortSignal.timeout(25000),
        headers: FETCH_HEADERS,
      });
      html = resp.ok ? await resp.text() : null;
    } catch {
      html = null;
    }

    if (!html) {
      await failJob(jobs, msg, "Could not fetch article URL");
      return;
    }

    // Follow canonical if feed URL pointed at a homepage
    const canonical = extractCanonicalUrl(html);
    const corrected = canonical ? deriveCorrectUrl(msg.url, canonical) : null;
    if (corrected) {
      try {
        const retry = await fetch(corrected, {
          signal: AbortSignal.timeout(25000),
          headers: FETCH_HEADERS,
        });
        const retryHtml = retry.ok ? await retry.text() : null;
        if (retryHtml) {
          html = retryHtml;
          articleUrl = corrected;
        }
      } catch {
        // fall through with original html
      }
    }

    try {
      article = extractArticle(html, articleUrl);
    } catch (err) {
      if (msg.feedContent) {
        article = extractArticleFromFeedContent(msg.feedContent, msg.feedTitle ?? "Article", articleUrl);
      } else {
        await failJob(jobs, msg, `Readability failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
  }

  if (!article || !article.content) {
    await failJob(jobs, msg, "No article content extracted");
    return;
  }

  const { html: rewritten, urls: imageUrls } = extractImageUrls(article.content, articleUrl);

  await jobs.putArticleMeta({
    jobId: msg.jobId,
    url: articleUrl,
    title: article.title || msg.feedTitle || "Article",
    byline: article.byline || "",
    content: rewritten,
    imageUrls,
    expectedImages: imageUrls.length,
    createdAt: Date.now(),
    weekKey: msg.weekKey,
    subId: msg.subId,
    subTitle: msg.subTitle,
  });

  if (msg.mode === "weekly" && msg.weekKey) {
    await jobs.addWeeklyJob(msg.weekKey, msg.jobId);
  }

  if (msg.mode === "single") {
    const job = await jobs.getJob(msg.jobId);
    if (job) {
      job.status = imageUrls.length > 0 ? "processing-images" : "assembling";
      job.title = article.title;
      job.updatedAt = Date.now();
      await jobs.putJob(job);
    }
  }

  // Fan out image jobs (one queue op each)
  for (let i = 0; i < imageUrls.length; i++) {
    const imgMsg: ProcessImageMsg = { jobId: msg.jobId, idx: i, url: imageUrls[i]! };
    await env.Q_PROCESS_IMAGE.send(imgMsg);
  }

  // Enqueue assembly — single epub per article. Weekly compilation is a
  // separate `assemble-epub` (kind: "weekly") sent by the scheduled handler.
  if (msg.mode === "single") {
    const assembleMsg: AssembleEpubMsg = { kind: "single", jobId: msg.jobId, emailTo: msg.emailTo ?? null };
    await env.Q_ASSEMBLE_EPUB.send(assembleMsg, { delaySeconds: ASSEMBLE_DELAY_SECONDS });
  }
}

async function failJob(jobs: KvJobRepo, msg: ParseArticleMsg, err: string): Promise<void> {
  if (msg.mode !== "single") return;
  const job = await jobs.getJob(msg.jobId);
  if (!job) return;
  job.status = "error";
  job.error = err;
  job.updatedAt = Date.now();
  await jobs.putJob(job);
}

function deriveCorrectUrl(feedUrl: string, canonicalUrl: string): string | null {
  try {
    const canonical = new URL(canonicalUrl, feedUrl);
    if (canonical.pathname !== "/" && canonical.pathname !== "") return null;
    const feed = new URL(feedUrl);
    const segments = feed.pathname.split("/").filter(Boolean);
    if (segments.length === 0) return null;
    const slug = segments[segments.length - 1];
    const candidate = new URL(`/${slug}/`, feed.origin);
    if (candidate.href === feed.href) return null;
    return candidate.href;
  } catch {
    return null;
  }
}
