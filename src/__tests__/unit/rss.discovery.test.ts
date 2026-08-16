import { describe, it, expect, vi, beforeEach } from "vitest";

const proxiedFetch = vi.fn();
vi.mock("../../http/proxied-fetch.ts", () => ({
  proxiedFetch: (...args: unknown[]) => proxiedFetch(...args),
}));

const { detectFeedUrl, fetchAndParseFeed, FeedBlockedError } = await import(
  "../../services/rss.ts"
);

const SITEGROUND_STUB =
  '<html><head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2F"></meta></head></html>';

const RSS_BODY =
  '<?xml version="1.0"?><rss version="2.0"><channel><title>The Blog</title>' +
  "<item><title>Post</title><link>https://example.com/post</link>" +
  "<pubDate>Tue, 01 Jul 2025 00:00:00 GMT</pubDate></item></channel></rss>";

interface StubResponse {
  status?: number;
  contentType?: string;
  body?: string;
}

/** Serve canned responses by URL; anything unlisted 404s. */
function serve(routes: Record<string, StubResponse>) {
  proxiedFetch.mockImplementation(async (url: string) => {
    const route = routes[url] ?? { status: 404, contentType: "text/html", body: "Not found" };
    return {
      status: route.status ?? 200,
      ok: (route.status ?? 200) >= 200 && (route.status ?? 200) < 300,
      headers: { get: () => route.contentType ?? "text/html" },
      text: async () => route.body ?? "",
    };
  });
}

beforeEach(() => {
  proxiedFetch.mockReset();
});

describe("detectFeedUrl", () => {
  it("reports a bot challenge as blocked, not as a missing feed", async () => {
    serve({
      "https://blocked.example/": {
        status: 202,
        contentType: "text/html",
        body: SITEGROUND_STUB,
      },
    });

    const result = await detectFeedUrl("https://blocked.example/");

    expect(result).toEqual({ reason: "blocked", detail: expect.stringContaining("SiteGround") });
    // It must not waste probes on a host that is already refusing us.
    expect(proxiedFetch).toHaveBeenCalledTimes(1);
  });

  it("uses the feed the page advertises", async () => {
    serve({
      "https://example.com/": {
        body:
          '<html><head><link rel="alternate" type="application/rss+xml" ' +
          'href="/?feed=rss2" /></head><body></body></html>',
      },
    });

    expect(await detectFeedUrl("https://example.com/")).toEqual({
      feedUrl: "https://example.com/?feed=rss2",
    });
  });

  it("finds a WordPress query-string feed when the page advertises none", async () => {
    serve({
      "https://wp.example/": { body: "<html><body>No link tags here</body></html>" },
      "https://wp.example/?feed=rss2": { contentType: "application/rss+xml", body: RSS_BODY },
    });

    expect(await detectFeedUrl("https://wp.example/")).toEqual({
      feedUrl: "https://wp.example/?feed=rss2",
    });
  });

  it("finds a feed alongside the submitted subpath", async () => {
    serve({
      "https://example.com/blog/": { body: "<html><body>posts</body></html>" },
      "https://example.com/blog/feed": { contentType: "application/rss+xml", body: RSS_BODY },
    });

    expect(await detectFeedUrl("https://example.com/blog/")).toEqual({
      feedUrl: "https://example.com/blog/feed",
    });
  });

  it("accepts a URL that is already a feed", async () => {
    serve({
      "https://example.com/feed": { contentType: "text/html", body: RSS_BODY },
    });

    expect(await detectFeedUrl("https://example.com/feed")).toEqual({
      feedUrl: "https://example.com/feed",
    });
  });

  it("ignores a probe that answers with HTML rather than a feed", async () => {
    serve({
      "https://spa.example/": { body: "<html><body>app</body></html>" },
      // Catch-all SPAs return their shell with a 200 for every path.
      "https://spa.example/feed": { body: "<html><body>app</body></html>" },
    });

    expect(await detectFeedUrl("https://spa.example/")).toEqual({ reason: "no-feed" });
  });

  it("falls back to feed-shaped links in the page", async () => {
    serve({
      "https://example.com/": {
        body: '<html><body><a href="/subscribe/posts.rss">Subscribe</a></body></html>',
      },
      "https://example.com/subscribe/posts.rss": {
        contentType: "application/rss+xml",
        body: RSS_BODY,
      },
    });

    expect(await detectFeedUrl("https://example.com/")).toEqual({
      feedUrl: "https://example.com/subscribe/posts.rss",
    });
  });

  it("reports an unreachable URL", async () => {
    serve({ "https://gone.example/": { status: 404, body: "Not found" } });

    expect(await detectFeedUrl("https://gone.example/")).toMatchObject({ reason: "unreachable" });
  });

  it("reports a transport failure as unreachable", async () => {
    proxiedFetch.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));

    expect(await detectFeedUrl("https://nxdomain.example/")).toMatchObject({
      reason: "unreachable",
    });
  });
});

describe("fetchAndParseFeed", () => {
  it("parses a feed", async () => {
    serve({
      "https://example.com/feed": { contentType: "application/rss+xml", body: RSS_BODY },
    });

    const feed = await fetchAndParseFeed("https://example.com/feed");
    expect(feed.title).toBe("The Blog");
    expect(feed.items).toHaveLength(1);
  });

  it("throws FeedBlockedError on a challenge instead of returning an empty feed", async () => {
    serve({
      "https://blocked.example/feed": {
        status: 202,
        contentType: "text/html",
        body: SITEGROUND_STUB,
      },
    });

    await expect(fetchAndParseFeed("https://blocked.example/feed")).rejects.toThrow(
      FeedBlockedError,
    );
  });

  it("throws when the response is not a feed document", async () => {
    serve({
      "https://example.com/feed": {
        contentType: "text/html",
        body: "<!doctype html><html><body><h1>Page not found</h1></body></html>",
      },
    });

    await expect(fetchAndParseFeed("https://example.com/feed")).rejects.toThrow(
      /did not return an RSS or Atom feed/,
    );
  });

  it("still throws on a plain HTTP error", async () => {
    serve({ "https://example.com/feed": { status: 500, body: "boom" } });

    await expect(fetchAndParseFeed("https://example.com/feed")).rejects.toThrow(/HTTP 500/);
  });
});
