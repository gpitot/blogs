import { createLogger } from "../logger.ts";

const logger = createLogger("http");

/**
 * Browser-like headers applied by default to every proxiedFetch call to avoid
 * WAFs flagging traffic as a bot. Callers can override any key (e.g. Accept)
 * by passing it in init.headers.
 */
export const DEFAULT_BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
};

function flattenHeaders(init: RequestInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) return out;
  if (init instanceof Headers) {
    init.forEach((v, k) => { out[k] = v; });
  } else if (Array.isArray(init)) {
    for (const [k, v] of init) out[k] = v;
  } else {
    Object.assign(out, init);
  }
  return out;
}

function mergeHeaders(init: RequestInit["headers"]): Record<string, string> {
  return { ...DEFAULT_BROWSER_HEADERS, ...flattenHeaders(init) };
}

/**
 * Drop-in replacement for fetch() that routes through the Cloudflare proxy
 * worker when PROXY_URL / PROXY_SECRET are set. Falls back to direct fetch
 * otherwise (local dev, tests).
 */
export async function proxiedFetch(url: string, init?: RequestInit): Promise<Response> {
  const proxyUrl = process.env.PROXY_URL;
  const proxySecret = process.env.PROXY_SECRET;
  if (!proxyUrl || !proxySecret) {
    throw new Error("proxiedFetch: PROXY_URL and PROXY_SECRET must be set");
  }

  const headers = mergeHeaders(init?.headers);

  const body = JSON.stringify({
    url,
    method: (init?.method ?? "GET").toUpperCase(),
    headers,
  });

  try {
    return await fetch(proxyUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Proxy-Secret": proxySecret,
      },
      body,
      signal: init?.signal ?? undefined,
    });
  } catch (err) {
    logger.error({ url, err: (err as Error).message }, "Proxy fetch failed");
    throw err;
  }
}
