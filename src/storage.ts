export interface Env {
  EPUB_CACHE: KVNamespace;
}

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
