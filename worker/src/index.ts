interface Env {
  PROXY_SECRET: string;
}

interface ProxyRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
}

const PRIVATE_HOST_RE =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|\[?fc00:|\[?fd00:)/i;

function isSafeTarget(url: URL): boolean {
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (PRIVATE_HOST_RE.test(url.hostname)) return false;
  return true;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    const secret = req.headers.get("X-Proxy-Secret");
    if (!env.PROXY_SECRET || secret !== env.PROXY_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    let payload: ProxyRequest;
    try {
      payload = (await req.json()) as ProxyRequest;
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }

    if (!payload?.url || typeof payload.url !== "string") {
      return new Response("Missing url", { status: 400 });
    }

    let target: URL;
    try {
      target = new URL(payload.url);
    } catch {
      return new Response("Invalid url", { status: 400 });
    }

    if (!isSafeTarget(target)) {
      return new Response("Target not allowed", { status: 400 });
    }

    const method = (payload.method ?? "GET").toUpperCase();
    const headers = new Headers(payload.headers ?? {});

    const upstream = await fetch(target.toString(), {
      method,
      headers,
      redirect: "follow",
    });

    const respHeaders = new Headers();
    const ct = upstream.headers.get("content-type");
    if (ct) respHeaders.set("content-type", ct);
    const cl = upstream.headers.get("content-length");
    if (cl) respHeaders.set("content-length", cl);

    return new Response(upstream.body, {
      status: upstream.status,
      headers: respHeaders,
    });
  },
};
