import type {
  Env,
  Subscription,
  PendingArticle,
  CacheEntry,
  WeeklyBookMeta,
  CachedArticleMeta,
  SubscriptionRepo,
  ArticleRepo,
  EpubRepo,
  JobRepo,
  JobMeta,
  ArticleMeta,
  StoredImage,
} from "./types.ts";

const JOB_TTL = 7 * 24 * 60 * 60; // 7 days
const IMAGE_TTL = 7 * 24 * 60 * 60; // 7 days
const WEEKLY_JOBS_TTL = 14 * 24 * 60 * 60; // 14 days — survives the 6h assemble delay + slack

const SUBS_INDEX_KEY = "subs:index";
const WEEKLY_BOOKS_INDEX_KEY = "weekly-books-index";
const MAX_WEEKLY_BOOKS = 8;
const CACHED_ARTICLES_INDEX_KEY = "cached-articles-index";
const MAX_CACHED_ARTICLES = 20;
const PENDING_ARTICLE_TTL = 30 * 24 * 60 * 60; // 30 days
const EPUB_CACHE_TTL = 604800; // 7 days
const WEEKLY_BOOK_TTL = 60 * 24 * 60 * 60; // 60 days

// ---------------------------------------------------------------------------
// Subscription repository
// ---------------------------------------------------------------------------

export class KvSubscriptionRepo implements SubscriptionRepo {
  constructor(private kv: KVNamespace) {}

  async list(): Promise<Subscription[]> {
    const ids = await this.listIds();
    const subs = await Promise.all(ids.map((id) => this.get(id)));
    return subs.filter(Boolean) as Subscription[];
  }

  async get(id: string): Promise<Subscription | null> {
    const val = await this.kv.get(`sub:${id}`);
    if (!val) return null;
    try {
      return JSON.parse(val) as Subscription;
    } catch {
      return null;
    }
  }

  async put(sub: Subscription): Promise<void> {
    await this.kv.put(`sub:${sub.id}`, JSON.stringify(sub));
    const ids = await this.listIds();
    if (!ids.includes(sub.id)) {
      ids.push(sub.id);
      await this.kv.put(SUBS_INDEX_KEY, JSON.stringify(ids));
    }
  }

  async delete(id: string): Promise<void> {
    await this.kv.delete(`sub:${id}`);
    const ids = await this.listIds();
    await this.kv.put(
      SUBS_INDEX_KEY,
      JSON.stringify(ids.filter((i) => i !== id)),
    );
  }

  private async listIds(): Promise<string[]> {
    const val = await this.kv.get(SUBS_INDEX_KEY);
    if (!val) return [];
    try {
      return JSON.parse(val) as string[];
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Article repository
// ---------------------------------------------------------------------------

export class KvArticleRepo implements ArticleRepo {
  constructor(private kv: KVNamespace) {}

  async get(id: string): Promise<PendingArticle | null> {
    const val = await this.kv.get(`pending-article:${id}`);
    if (!val) return null;
    try {
      return JSON.parse(val) as PendingArticle;
    } catch {
      return null;
    }
  }

  async put(article: PendingArticle): Promise<void> {
    await this.kv.put(
      `pending-article:${article.id}`,
      JSON.stringify(article),
      { expirationTtl: PENDING_ARTICLE_TTL },
    );
  }
}

// ---------------------------------------------------------------------------
// EPUB repository
// ---------------------------------------------------------------------------

export class KvEpubRepo implements EpubRepo {
  constructor(private kv: KVNamespace) {}

  async getCachedMeta(cacheKey: string): Promise<CacheEntry | null> {
    const value = await this.kv.get(cacheKey);
    if (!value) return null;
    try {
      return JSON.parse(value) as CacheEntry;
    } catch {
      return null;
    }
  }

  async putCachedMeta(cacheKey: string, entry: CacheEntry): Promise<void> {
    await this.kv.put(cacheKey, JSON.stringify(entry), {
      expirationTtl: EPUB_CACHE_TTL,
    });
  }

  async putEpubData(
    kvKey: string,
    data: Uint8Array,
    ttlSeconds: number,
  ): Promise<void> {
    await this.kv.put(kvKey, data.buffer as ArrayBuffer, {
      expirationTtl: ttlSeconds,
    });
  }

  async getEpubData(kvKey: string): Promise<ArrayBuffer | null> {
    return await this.kv.get(kvKey, { type: "arrayBuffer" });
  }

  async listWeeklyBooks(): Promise<WeeklyBookMeta[]> {
    const val = await this.kv.get(WEEKLY_BOOKS_INDEX_KEY);
    if (!val) return [];
    try {
      return JSON.parse(val) as WeeklyBookMeta[];
    } catch {
      return [];
    }
  }

  async addWeeklyBook(meta: WeeklyBookMeta, data: Uint8Array): Promise<void> {
    await this.kv.put(meta.kvKey, data.buffer as ArrayBuffer, {
      expirationTtl: WEEKLY_BOOK_TTL,
    });
    const books = await this.listWeeklyBooks();
    const updated = [meta, ...books.filter((b) => b.weekKey !== meta.weekKey)]
      .slice(0, MAX_WEEKLY_BOOKS);
    await this.kv.put(WEEKLY_BOOKS_INDEX_KEY, JSON.stringify(updated));
  }

  async getWeeklyBookData(
    weekKey: string,
  ): Promise<{ meta: WeeklyBookMeta; buf: ArrayBuffer } | null> {
    const books = await this.listWeeklyBooks();
    const meta = books.find((b) => b.weekKey === weekKey);
    if (!meta) return null;
    const buf = await this.kv.get(meta.kvKey, { type: "arrayBuffer" });
    if (!buf) return null;
    return { meta, buf };
  }

  async listCachedArticles(): Promise<CachedArticleMeta[]> {
    const val = await this.kv.get(CACHED_ARTICLES_INDEX_KEY);
    console.log("listCachedArticles", { val });
    if (!val) return [];
    try {
      return JSON.parse(val) as CachedArticleMeta[];
    } catch {
      return [];
    }
  }

  async addCachedArticle(meta: CachedArticleMeta): Promise<void> {
    console.log('addCachedArticle', { meta });
    const articles = await this.listCachedArticles();
    console.log("Existing cached articles", { articles });
    const updated = [meta, ...articles.filter((a) => a.cacheKey !== meta.cacheKey)]
      .slice(0, MAX_CACHED_ARTICLES);
    console.log("Updated cached articles list", { updated });
    await this.kv.put(CACHED_ARTICLES_INDEX_KEY, JSON.stringify(updated));
  }
}

// ---------------------------------------------------------------------------
// Job / article-pipeline repository
// ---------------------------------------------------------------------------

export class KvJobRepo implements JobRepo {
  constructor(private kv: KVNamespace) {}

  async getJob(jobId: string): Promise<JobMeta | null> {
    const val = await this.kv.get(`job:${jobId}`);
    if (!val) return null;
    try {
      return JSON.parse(val) as JobMeta;
    } catch {
      return null;
    }
  }

  async putJob(job: JobMeta): Promise<void> {
    await this.kv.put(`job:${job.jobId}`, JSON.stringify(job), {
      expirationTtl: JOB_TTL,
    });
  }

  async getArticleMeta(jobId: string): Promise<ArticleMeta | null> {
    const val = await this.kv.get(`article-meta:${jobId}`);
    if (!val) return null;
    try {
      return JSON.parse(val) as ArticleMeta;
    } catch {
      return null;
    }
  }

  async putArticleMeta(meta: ArticleMeta): Promise<void> {
    await this.kv.put(`article-meta:${meta.jobId}`, JSON.stringify(meta), {
      expirationTtl: JOB_TTL,
    });
  }

  async putImage(
    jobId: string,
    idx: number,
    filename: string,
    mediaType: StoredImage["mediaType"],
    data: Uint8Array,
  ): Promise<void> {
    const padded = String(idx).padStart(4, "0");
    // Store binary and a small meta record side-by-side
    await Promise.all([
      this.kv.put(`image-data:${jobId}:${padded}`, data.buffer as ArrayBuffer, {
        expirationTtl: IMAGE_TTL,
      }),
      this.kv.put(
        `image-meta:${jobId}:${padded}`,
        JSON.stringify({ filename, mediaType, size: data.byteLength } satisfies StoredImage),
        { expirationTtl: IMAGE_TTL },
      ),
    ]);
  }

  async getImage(
    jobId: string,
    idx: number,
  ): Promise<{ filename: string; mediaType: StoredImage["mediaType"]; data: ArrayBuffer } | null> {
    const padded = String(idx).padStart(4, "0");
    const [metaVal, data] = await Promise.all([
      this.kv.get(`image-meta:${jobId}:${padded}`),
      this.kv.get(`image-data:${jobId}:${padded}`, { type: "arrayBuffer" }),
    ]);
    if (!metaVal || !data) return null;
    try {
      const meta = JSON.parse(metaVal) as StoredImage;
      return { filename: meta.filename, mediaType: meta.mediaType, data };
    } catch {
      return null;
    }
  }

  async listImageIndices(jobId: string): Promise<number[]> {
    const prefix = `image-meta:${jobId}:`;
    const indices: number[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.kv.list({ prefix, cursor });
      for (const k of res.keys) {
        const tail = k.name.substring(prefix.length);
        const n = parseInt(tail, 10);
        if (!isNaN(n)) indices.push(n);
      }
      cursor = res.list_complete ? undefined : res.cursor;
    } while (cursor);
    return indices;
  }

  async addWeeklyJob(weekKey: string, jobId: string): Promise<void> {
    const key = `weekly-jobs:${weekKey}`;
    const existing = await this.kv.get(key);
    let ids: string[] = [];
    if (existing) {
      try {
        ids = JSON.parse(existing) as string[];
      } catch {
        ids = [];
      }
    }
    if (!ids.includes(jobId)) ids.push(jobId);
    await this.kv.put(key, JSON.stringify(ids), {
      expirationTtl: WEEKLY_JOBS_TTL,
    });
  }

  async listWeeklyJobs(weekKey: string): Promise<string[]> {
    const val = await this.kv.get(`weekly-jobs:${weekKey}`);
    if (!val) return [];
    try {
      return JSON.parse(val) as string[];
    } catch {
      return [];
    }
  }
}
