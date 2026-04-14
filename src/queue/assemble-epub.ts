import type { Env, JobMeta, WeeklyBookMeta, CachedArticleMeta } from "../repositories/types.ts";
import type { AssembleEpubMsg } from "./types.ts";
import { KvJobRepo, KvEpubRepo } from "../repositories/kv.ts";
import { generateEpub } from "../services/epub.ts";
import { inlineImageFilenames, type EpubImage } from "../services/images.ts";
import { urlToKey } from "../utils.ts";
import { sendEpubEmail } from "../services/email.service.ts";

const REQUEUE_DELAY_SECONDS = 15;
const MAX_ASSEMBLE_ATTEMPTS = 6; // ~90s total wait for images
const EPUB_CACHE_TTL = 604800; // 7 days
const WEEKLY_BOOK_TTL = 60 * 24 * 60 * 60; // 60 days

/**
 * Assemble consumer. Dispatches on `kind`:
 * - single: build one-article EPUB for a finished job
 * - weekly: build the weekly compilation from all article jobs in a week bucket
 *
 * Both variants self-requeue with a delay if images aren't all present yet,
 * bounded by MAX_ASSEMBLE_ATTEMPTS.
 */
export async function handleAssembleEpub(msg: AssembleEpubMsg, env: Env): Promise<void> {
  if (msg.kind === "single") return handleAssembleSingle(msg, env);
  if (msg.kind === "weekly") return handleAssembleWeekly(msg, env);
}

async function handleAssembleSingle(msg: AssembleEpubMsg, env: Env): Promise<void> {
  if (!msg.jobId) return;
  const jobs = new KvJobRepo(env.EPUB_CACHE);
  const epubs = new KvEpubRepo(env.EPUB_CACHE);

  const meta = await jobs.getArticleMeta(msg.jobId);
  if (!meta) {
    await markJobError(jobs, msg.jobId, "Article meta missing");
    return;
  }

  const indices = await jobs.listImageIndices(msg.jobId);
  if (indices.length < meta.expectedImages) {
    const attempts = (meta.assembleAttempts ?? 0) + 1;
    if (attempts > MAX_ASSEMBLE_ATTEMPTS) {
      console.warn(
        `[assemble] job ${msg.jobId}: giving up waiting for images (${indices.length}/${meta.expectedImages})`,
      );
      // Proceed with what we have
    } else {
      meta.assembleAttempts = attempts;
      await jobs.putArticleMeta(meta);
      await env.Q_ASSEMBLE_EPUB.send(msg, { delaySeconds: REQUEUE_DELAY_SECONDS });
      return;
    }
  }

  const job = await jobs.getJob(msg.jobId);
  if (job) {
    job.status = "assembling";
    job.updatedAt = Date.now();
    await jobs.putJob(job);
  }

  const { images, filenamesByIdx } = await loadImages(jobs, msg.jobId, indices);
  const content = inlineImageFilenames(meta.content, filenamesByIdx);

  const epubBytes = generateEpub(
    meta.title || "Article",
    meta.byline || "Unknown Author",
    [{ title: meta.title || "Article", byline: meta.byline, content }],
    images,
  );

  const cacheKey = await urlToKey(meta.url);
  const kvKey = `epub-data:${cacheKey.replace("epub:", "")}`;
  const createdAt = Date.now();

  await epubs.putEpubData(kvKey, epubBytes, EPUB_CACHE_TTL);
  await epubs.putCachedMeta(cacheKey, { kvKey, title: meta.title, createdAt, size: epubBytes.byteLength });
  const cachedMeta: CachedArticleMeta = { cacheKey, title: meta.title, createdAt, size: epubBytes.byteLength };
  await epubs.addCachedArticle(cachedMeta);

  if (job) {
    job.status = "done";
    job.cacheKey = cacheKey;
    job.title = meta.title;
    job.updatedAt = Date.now();
    await jobs.putJob(job);
  }

  if (msg.emailTo && env.RESEND_API_KEY) {
    try {
      const safeTitle = meta.title.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim() || "article";
      await sendEpubEmail({
        apiKey: env.RESEND_API_KEY,
        fromAddress: env.RESEND_FROM_ADDRESS,
        to: msg.emailTo,
        title: meta.title,
        filename: `${safeTitle}.epub`,
        epubBytes,
      });
    } catch (err) {
      console.error(`[assemble] email delivery failed for job ${msg.jobId}:`, err);
    }
  }
}

async function handleAssembleWeekly(msg: AssembleEpubMsg, env: Env): Promise<void> {
  if (!msg.weekKey) return;
  const jobs = new KvJobRepo(env.EPUB_CACHE);
  const epubs = new KvEpubRepo(env.EPUB_CACHE);

  const jobIds = await jobs.listWeeklyJobs(msg.weekKey);
  if (jobIds.length === 0) {
    console.log(`[assemble-weekly] ${msg.weekKey}: no articles this week, skipping.`);
    return;
  }

  // Best effort: collect whatever articles have finished.
  const chapters: Array<{ title: string; byline: string; content: string }> = [];
  const allImages: EpubImage[] = [];

  for (const jobId of jobIds) {
    const meta = await jobs.getArticleMeta(jobId);
    if (!meta) continue;
    const indices = await jobs.listImageIndices(jobId);
    const { images, filenamesByIdx } = await loadImages(jobs, jobId, indices);
    // Rename each article's images to a globally-unique filename before merging
    const renamedByIdx: Record<number, string> = {};
    for (const [idxStr, fname] of Object.entries(filenamesByIdx)) {
      const idx = parseInt(idxStr, 10);
      const ext = fname.endsWith(".svg") ? "svg" : "jpg";
      const newName = `img${String(allImages.length + 1).padStart(3, "0")}.${ext}`;
      renamedByIdx[idx] = newName;
      const img = images.find((im) => im.filename === fname);
      if (img) allImages.push({ ...img, filename: newName });
    }
    const content = inlineImageFilenames(meta.content, renamedByIdx);
    const chapterTitle = meta.subTitle ? `${meta.subTitle}: ${meta.title}` : meta.title;
    chapters.push({ title: chapterTitle, byline: meta.byline || "Unknown Author", content });
  }

  if (chapters.length === 0) {
    console.log(`[assemble-weekly] ${msg.weekKey}: no extractable articles, skipping book.`);
    return;
  }

  const now = new Date();
  const bookTitle = `Weekly Reading – ${now.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  })}`;

  const epubBytes = generateEpub(bookTitle, "Various Authors", chapters, allImages);

  const meta: WeeklyBookMeta = {
    weekKey: msg.weekKey,
    kvKey: `weekly-book-data:${msg.weekKey}`,
    title: bookTitle,
    createdAt: Date.now(),
    articleCount: chapters.length,
    size: epubBytes.byteLength,
  };

  await epubs.addWeeklyBook(meta, epubBytes);
  // WEEKLY_BOOK_TTL is applied inside addWeeklyBook via putEpubData contract (see KvEpubRepo)
  void WEEKLY_BOOK_TTL;
  console.log(
    `[assemble-weekly] ${msg.weekKey}: compiled "${bookTitle}" with ${chapters.length} chapters (${Math.round(
      epubBytes.byteLength / 1024,
    )} KB).`,
  );
}

async function loadImages(
  jobs: KvJobRepo,
  jobId: string,
  indices: number[],
): Promise<{ images: EpubImage[]; filenamesByIdx: Record<number, string> }> {
  const images: EpubImage[] = [];
  const filenamesByIdx: Record<number, string> = {};
  for (const idx of indices) {
    const stored = await jobs.getImage(jobId, idx);
    if (!stored || !stored.filename) continue; // skip sentinels
    images.push({
      filename: stored.filename,
      mediaType: stored.mediaType,
      data: new Uint8Array(stored.data),
    });
    filenamesByIdx[idx] = stored.filename;
  }
  return { images, filenamesByIdx };
}

async function markJobError(jobs: KvJobRepo, jobId: string, error: string): Promise<void> {
  const job = await jobs.getJob(jobId);
  if (!job) return;
  job.status = "error";
  job.error = error;
  job.updatedAt = Date.now();
  await jobs.putJob(job);
}
