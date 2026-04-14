import type { ParseArticleMsg, ProcessImageMsg, AssembleEpubMsg, CheckFeedMsg } from "../queue/types.ts";

export interface Env {
  EPUB_CACHE: KVNamespace;
  Q_PARSE_ARTICLE: Queue<ParseArticleMsg>;
  Q_PROCESS_IMAGE: Queue<ProcessImageMsg>;
  Q_ASSEMBLE_EPUB: Queue<AssembleEpubMsg>;
  Q_CHECK_FEED: Queue<CheckFeedMsg>;
  RESEND_API_KEY: string;
  RESEND_FROM_ADDRESS: string;
  EMAIL_ALLOWLIST?: string;
  ADMIN_SECRET?: string;
}

// ---------------------------------------------------------------------------
// Job / pipeline types
// ---------------------------------------------------------------------------

export type JobStatus = "queued" | "parsing" | "processing-images" | "assembling" | "done" | "error";

export interface JobMeta {
  jobId: string;
  url: string;
  status: JobStatus;
  error?: string;
  cacheKey?: string;
  title?: string;
  emailTo?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ArticleMeta {
  jobId: string;
  url: string;
  title: string;
  byline: string;
  content: string; // XHTML with image src replaced to img/imgNNN.*
  imageUrls: string[]; // absolute URLs in order
  expectedImages: number;
  createdAt: number;
  // Optional: when produced via weekly flow, the week bucket
  weekKey?: string;
  subId?: string;
  subTitle?: string;
  // Bounded retry for assemble
  assembleAttempts?: number;
}

export interface StoredImage {
  filename: string;
  mediaType: "image/jpeg" | "image/svg+xml";
  size: number;
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export interface RecentArticle {
  id: string;
  title: string;
  createdAt: number;
}

export interface Subscription {
  id: string;
  feedUrl: string;
  siteUrl: string;
  title: string;
  addedAt: number;
  lastChecked: number | null;
  seenGuids: string[];
  recentArticles: RecentArticle[];
}

export interface PendingArticle {
  id: string;
  url: string;
  title: string;
  byline: string;
  content: string;
  savedAt: number;
  subId: string;
  subTitle: string;
}

export interface CacheEntry {
  kvKey: string;
  title: string;
  createdAt: number;
  size: number;
}

export interface WeeklyBookMeta {
  weekKey: string;
  kvKey: string;
  title: string;
  createdAt: number;
  articleCount: number;
  size: number;
}

export interface CachedArticleMeta {
  cacheKey: string;
  title: string;
  createdAt: number;
  size: number;
}

// ---------------------------------------------------------------------------
// Repository interfaces
// ---------------------------------------------------------------------------

export interface SubscriptionRepo {
  list(): Promise<Subscription[]>;
  get(id: string): Promise<Subscription | null>;
  put(sub: Subscription): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface ArticleRepo {
  get(id: string): Promise<PendingArticle | null>;
  put(article: PendingArticle): Promise<void>;
}

export interface JobRepo {
  getJob(jobId: string): Promise<JobMeta | null>;
  putJob(job: JobMeta): Promise<void>;
  getArticleMeta(jobId: string): Promise<ArticleMeta | null>;
  putArticleMeta(meta: ArticleMeta): Promise<void>;
  putImage(jobId: string, idx: number, filename: string, mediaType: StoredImage["mediaType"], data: Uint8Array): Promise<void>;
  getImage(jobId: string, idx: number): Promise<{ filename: string; mediaType: StoredImage["mediaType"]; data: ArrayBuffer } | null>;
  listImageIndices(jobId: string): Promise<number[]>;
  // Weekly helpers
  addWeeklyJob(weekKey: string, jobId: string): Promise<void>;
  listWeeklyJobs(weekKey: string): Promise<string[]>;
}

export interface EpubRepo {
  getCachedMeta(cacheKey: string): Promise<CacheEntry | null>;
  putCachedMeta(cacheKey: string, entry: CacheEntry): Promise<void>;
  putEpubData(kvKey: string, data: Uint8Array, ttlSeconds: number): Promise<void>;
  getEpubData(kvKey: string): Promise<ArrayBuffer | null>;
  listWeeklyBooks(): Promise<WeeklyBookMeta[]>;
  addWeeklyBook(meta: WeeklyBookMeta, data: Uint8Array): Promise<void>;
  getWeeklyBookData(
    weekKey: string,
  ): Promise<{ meta: WeeklyBookMeta; buf: ArrayBuffer } | null>;
  listCachedArticles(): Promise<CachedArticleMeta[]>;
  addCachedArticle(meta: CachedArticleMeta): Promise<void>;
}

export const MAX_SEEN_GUIDS = 200;
export const MAX_RECENT_ARTICLES = 20;
