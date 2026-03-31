export interface Env {
  EPUB_CACHE: KVNamespace;
}

// ---------------------------------------------------------------------------
// Subscription types
// ---------------------------------------------------------------------------

export interface RecentArticle {
  id: string;       // pending article ID – used in /download/article/:id
  title: string;
  createdAt: number;
}

export interface Subscription {
  id: string;
  feedUrl: string;
  siteUrl: string;   // URL the user originally submitted
  title: string;     // feed title
  addedAt: number;
  lastChecked: number | null;
  seenGuids: string[];       // de-dup ring-buffer (capped at MAX_SEEN_GUIDS)
  recentArticles: RecentArticle[]; // capped at MAX_RECENT_ARTICLES
}

export const MAX_SEEN_GUIDS = 200;
export const MAX_RECENT_ARTICLES = 20;

const SUBS_INDEX_KEY = "subs:index";

// ---------------------------------------------------------------------------
// Single-article EPUB cache (used by /convert route only)
// ---------------------------------------------------------------------------

interface CacheEntry {
  kvKey: string;
  title: string;
  createdAt: number;
  size: number;
}

/** Derive a stable cache key from a URL using SHA-256 */
export async function urlToKey(url: string): Promise<string> {
  const bytes = new TextEncoder().encode(url);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(hash))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `epub:${hex}`;
}

/** Check KV cache for a previously converted URL. Returns the entry or null. */
export async function getCached(
  env: Env,
  cacheKey: string,
): Promise<CacheEntry | null> {
  const value = await env.EPUB_CACHE.get(cacheKey);
  if (!value) return null;
  try {
    return JSON.parse(value) as CacheEntry;
  } catch {
    return null;
  }
}

/** Store a cache entry in KV with a 7-day TTL. */
export async function putCached(
  env: Env,
  cacheKey: string,
  entry: CacheEntry,
): Promise<void> {
  await env.EPUB_CACHE.put(cacheKey, JSON.stringify(entry), {
    expirationTtl: 604800, // 7 days
  });
}

/** Upload an EPUB to KV. */
export async function putEpub(
  env: Env,
  kvKey: string,
  data: Uint8Array,
): Promise<void> {
  await env.EPUB_CACHE.put(kvKey, data.buffer as ArrayBuffer, {
    expirationTtl: 604800, // 7 days
  });
}

/** Retrieve an EPUB from KV. Returns a Response or null if not found. */
export async function getEpub(
  env: Env,
  kvKey: string,
  title: string,
  size: number,
): Promise<Response | null> {
  const buf = await env.EPUB_CACHE.get(kvKey, { type: "arrayBuffer" });
  if (!buf) return null;

  const safeTitle = title.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim() || "article";
  const filename = `${safeTitle}.epub`;

  return new Response(buf, {
    headers: {
      "Content-Type": "application/epub+zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": size.toString(),
      "Cache-Control": "public, max-age=604800",
    },
  });
}

// ---------------------------------------------------------------------------
// Pending articles – extracted HTML saved for lazy EPUB generation and
// inclusion in the weekly book. TTL is 30 days.
// ---------------------------------------------------------------------------

export interface PendingArticle {
  id: string;
  url: string;
  title: string;
  byline: string;
  content: string;  // cleaned XHTML content (no images embedded yet)
  savedAt: number;
  subId: string;
  subTitle: string;
}

const PENDING_ARTICLE_TTL = 30 * 24 * 60 * 60; // 30 days in seconds

export async function putPendingArticle(
  env: Env,
  article: PendingArticle,
): Promise<void> {
  await env.EPUB_CACHE.put(
    `pending-article:${article.id}`,
    JSON.stringify(article),
    { expirationTtl: PENDING_ARTICLE_TTL },
  );
}

export async function getPendingArticle(
  env: Env,
  id: string,
): Promise<PendingArticle | null> {
  const val = await env.EPUB_CACHE.get(`pending-article:${id}`);
  if (!val) return null;
  try {
    return JSON.parse(val) as PendingArticle;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Weekly books index
// ---------------------------------------------------------------------------

export interface WeeklyBookMeta {
  weekKey: string;   // e.g. "2026-W14"
  kvKey: string;     // KV key for the binary EPUB data
  title: string;     // e.g. "Weekly Reading – March 30, 2026"
  createdAt: number;
  articleCount: number;
  size: number;
}

const WEEKLY_BOOKS_INDEX_KEY = "weekly-books-index";
const MAX_WEEKLY_BOOKS = 8;
const WEEKLY_BOOK_TTL = 60 * 24 * 60 * 60; // 60 days in seconds

export async function listWeeklyBooks(env: Env): Promise<WeeklyBookMeta[]> {
  const val = await env.EPUB_CACHE.get(WEEKLY_BOOKS_INDEX_KEY);
  if (!val) return [];
  try {
    return JSON.parse(val) as WeeklyBookMeta[];
  } catch {
    return [];
  }
}

export async function addWeeklyBook(
  env: Env,
  meta: WeeklyBookMeta,
  data: Uint8Array,
): Promise<void> {
  await env.EPUB_CACHE.put(meta.kvKey, data.buffer as ArrayBuffer, {
    expirationTtl: WEEKLY_BOOK_TTL,
  });
  const books = await listWeeklyBooks(env);
  const updated = [meta, ...books.filter((b) => b.weekKey !== meta.weekKey)]
    .slice(0, MAX_WEEKLY_BOOKS);
  await env.EPUB_CACHE.put(WEEKLY_BOOKS_INDEX_KEY, JSON.stringify(updated));
}

export async function getWeeklyBookData(
  env: Env,
  weekKey: string,
): Promise<{ meta: WeeklyBookMeta; buf: ArrayBuffer } | null> {
  const books = await listWeeklyBooks(env);
  const meta = books.find((b) => b.weekKey === weekKey);
  if (!meta) return null;
  const buf = await env.EPUB_CACHE.get(meta.kvKey, { type: "arrayBuffer" });
  if (!buf) return null;
  return { meta, buf };
}

// ---------------------------------------------------------------------------
// Subscription storage
// ---------------------------------------------------------------------------

/** Generate a random 16-hex-char ID. */
export function generateId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function listSubscriptionIds(env: Env): Promise<string[]> {
  const val = await env.EPUB_CACHE.get(SUBS_INDEX_KEY);
  if (!val) return [];
  try {
    return JSON.parse(val) as string[];
  } catch {
    return [];
  }
}

export async function getSubscription(
  env: Env,
  id: string,
): Promise<Subscription | null> {
  const val = await env.EPUB_CACHE.get(`sub:${id}`);
  if (!val) return null;
  try {
    return JSON.parse(val) as Subscription;
  } catch {
    return null;
  }
}

export async function listSubscriptions(env: Env): Promise<Subscription[]> {
  const ids = await listSubscriptionIds(env);
  const subs = await Promise.all(ids.map((id) => getSubscription(env, id)));
  return subs.filter(Boolean) as Subscription[];
}

export async function putSubscription(
  env: Env,
  sub: Subscription,
): Promise<void> {
  await env.EPUB_CACHE.put(`sub:${sub.id}`, JSON.stringify(sub));

  const ids = await listSubscriptionIds(env);
  if (!ids.includes(sub.id)) {
    ids.push(sub.id);
    await env.EPUB_CACHE.put(SUBS_INDEX_KEY, JSON.stringify(ids));
  }
}

export async function deleteSubscription(
  env: Env,
  id: string,
): Promise<void> {
  await env.EPUB_CACHE.delete(`sub:${id}`);
  const ids = await listSubscriptionIds(env);
  await env.EPUB_CACHE.put(
    SUBS_INDEX_KEY,
    JSON.stringify(ids.filter((i) => i !== id)),
  );
}
