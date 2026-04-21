export interface AwsEnv {
  DYNAMO_TABLE: string;
  S3_BUCKET: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_ADDRESS?: string;
  EMAIL_ALLOWLIST?: string;
}

// ---------------------------------------------------------------------------
// User types
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  name: string;
  email: string;
  apiKey: string;
  passwordHash: string;
  approved: boolean;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Feed & subscription types
// ---------------------------------------------------------------------------

export interface ConvertedArticle {
  cacheKey: string;
  articleId: string;
  title: string;
  createdAt: number;
}

export interface Feed {
  id: string;
  feedUrl: string;
  siteUrl: string;
  title: string;
  lastChecked: number | null;
  seenGuids: string[];
  convertedArticles: ConvertedArticle[];
}

export interface UserSubscription {
  userId: string;
  feedId: string;
  addedAt: number;
}

export interface PopularSubscription {
  feedUrl: string;
  siteUrl: string;
  title: string;
  subscriberCount: number;
}

// ---------------------------------------------------------------------------
// Article types
// ---------------------------------------------------------------------------

export interface PendingArticle {
  id: string;
  url: string;
  title: string;
  byline: string;
  content: string;
  savedAt: number;
  feedId: string;
  feedTitle: string;
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
  url: string;
  createdAt: number;
  size: number;
}

// ---------------------------------------------------------------------------
// Repository interfaces
// ---------------------------------------------------------------------------

export interface FeedRepo {
  get(id: string): Promise<Feed | null>;
  getByUrl(feedUrl: string): Promise<Feed | null>;
  put(feed: Feed): Promise<void>;
  list(): Promise<Feed[]>;
  getPopular(): Promise<PopularSubscription[]>;
  incrementPopular(feedUrl: string, siteUrl: string, title: string): Promise<void>;
  decrementPopular(feedUrl: string): Promise<void>;
}

export interface UserSubscriptionRepo {
  listForUser(userId: string): Promise<UserSubscription[]>;
  subscribe(userId: string, feedId: string): Promise<void>;
  unsubscribe(userId: string, feedId: string): Promise<void>;
  isSubscribed(userId: string, feedId: string): Promise<boolean>;
  getSubscriberUserIds(feedId: string): Promise<string[]>;
}

export interface UserRepo {
  getById(id: string): Promise<User | null>;
  getByApiKey(apiKey: string): Promise<User | null>;
  getByEmail(email: string): Promise<User | null>;
  create(user: User): Promise<void>;
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
  listWeeklyBooks(userId: string): Promise<WeeklyBookMeta[]>;
  addWeeklyBook(userId: string, meta: WeeklyBookMeta, data: Uint8Array): Promise<void>;
  getWeeklyBookData(
    userId: string,
    weekKey: string,
  ): Promise<{ meta: WeeklyBookMeta; buf: ArrayBuffer } | null>;
  listCachedArticles(userId: string): Promise<CachedArticleMeta[]>;
  addCachedArticle(userId: string, meta: CachedArticleMeta): Promise<void>;
}

export const MAX_SEEN_GUIDS = 200;
export const MAX_CONVERTED_ARTICLES = 20;
