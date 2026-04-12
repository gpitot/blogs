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
} from "./types.ts";

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
