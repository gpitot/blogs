export interface AwsEnv {
  DYNAMO_TABLE: string;
  S3_BUCKET: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_ADDRESS?: string;
  EMAIL_ALLOWLIST?: string;
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export interface ConvertedArticle {
  cacheKey: string;
  articleId: string;
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
  convertedArticles: ConvertedArticle[];
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
export const MAX_CONVERTED_ARTICLES = 20;
