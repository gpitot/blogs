/** Generate a random 16-hex-char ID. */
export function generateId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

/** Derive a stable feed ID from a feed URL using SHA-256 */
export async function feedUrlToId(feedUrl: string): Promise<string> {
  const bytes = new TextEncoder().encode(feedUrl);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
