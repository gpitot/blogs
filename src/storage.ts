export interface Env {
  EPUB_CACHE: KVNamespace;
  EPUB_BUCKET: R2Bucket;
}

interface CacheEntry {
  r2Key: string;
  title: string;
  createdAt: number;
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

/** Upload an EPUB to R2. */
export async function putEpub(
  env: Env,
  r2Key: string,
  data: Uint8Array,
  title: string,
): Promise<void> {
  await env.EPUB_BUCKET.put(r2Key, data, {
    httpMetadata: { contentType: "application/epub+zip" },
    customMetadata: { title, createdAt: Date.now().toString() },
  });
}

/** Stream an EPUB from R2. Returns a Response or null if not found. */
export async function getEpub(
  env: Env,
  r2Key: string,
  title: string,
): Promise<Response | null> {
  const object = await env.EPUB_BUCKET.get(r2Key);
  if (!object) return null;

  const safeTitle = title.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim() || "article";
  const filename = `${safeTitle}.epub`;

  return new Response(object.body, {
    headers: {
      "Content-Type": "application/epub+zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": object.size.toString(),
      "Cache-Control": "public, max-age=604800",
    },
  });
}
