import { describe, it, expect, vi, beforeEach } from "vitest";
import { PostsService } from "../../services/posts.service.ts";
import type { ArticleRepo } from "../../repositories/types.ts";
import type { HtmlFetcher } from "../../services/interfaces.ts";
import type { FeedItem } from "../../services/rss.ts";

function mockArticleRepo(): ArticleRepo {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
  };
}

function mockFetcher(overrides?: Partial<HtmlFetcher>): HtmlFetcher {
  return {
    fetch: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function makeFeedItem(overrides?: Partial<FeedItem>): FeedItem {
  return {
    guid: "guid-1",
    title: "Test Post",
    link: "https://example.com/post-1",
    pubDate: Date.now(),
    content: "",
    ...overrides,
  };
}

// Minimal HTML that Readability can extract
const ARTICLE_HTML = `
<!DOCTYPE html>
<html>
<head><title>Test Post</title></head>
<body>
  <article>
    <h1>Test Post</h1>
    <p>This is the main article content. It needs to be long enough for Readability to consider it worth extracting. Here is some more text to make it substantial enough. The article discusses various topics in depth.</p>
    <p>Another paragraph of content that adds more substance to the article. This helps Readability determine this is actual article content rather than navigation or sidebar elements.</p>
    <p>A third paragraph to really drive the point home. Readability uses heuristics to determine what is and isn't article content, and longer articles are more likely to be correctly identified.</p>
  </article>
</body>
</html>`;

// Same shape as ARTICLE_HTML but unmistakably longer than any feed preview
// used below, so the "keep the longer body" guard has an obvious winner.
const LONG_ARTICLE_HTML = `
<!DOCTYPE html>
<html>
<head><title>Test Post</title></head>
<body>
  <article>
    <h1>Test Post</h1>
    <p>${"The complete article body continues well past where the feed preview stopped. ".repeat(20)}</p>
    <p>Readability uses heuristics to decide what counts as article content, and a longer body is more reliably identified.</p>
  </article>
</body>
</html>`;

describe("PostsService", () => {
  let repo: ArticleRepo;
  let fetcher: HtmlFetcher;
  let service: PostsService;

  beforeEach(() => {
    repo = mockArticleRepo();
    fetcher = mockFetcher();
    service = new PostsService(repo, fetcher);
  });

  describe("fetchAndSave", () => {
    it("prefers feed content:encoded when >= 500 chars", async () => {
      const longContent =
        "<p>" + "A".repeat(600) + "</p>";
      const item = makeFeedItem({ content: longContent });

      const result = await service.fetchAndSave(item, "sub1", "Blog");

      expect(result).not.toBeNull();
      expect(result!.content).toContain("A".repeat(600));
      // Should NOT have called the HTML fetcher
      expect(fetcher.fetch).not.toHaveBeenCalled();
      expect(repo.put).toHaveBeenCalled();
    });

    it("falls back to HTML fetch + Readability when feed content is short", async () => {
      const item = makeFeedItem({ content: "<p>Short</p>" });
      (fetcher.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        ARTICLE_HTML,
      );

      const result = await service.fetchAndSave(item, "sub1", "Blog");

      expect(fetcher.fetch).toHaveBeenCalledWith(item.link);
      expect(result).not.toBeNull();
      expect(result!.title).toBe("Test Post");
      expect(repo.put).toHaveBeenCalled();
    });

    it("returns null when no content available", async () => {
      const item = makeFeedItem({ content: "" });
      // fetcher returns null (fetch failed)

      const result = await service.fetchAndSave(item, "sub1", "Blog");

      expect(result).toBeNull();
      expect(repo.put).not.toHaveBeenCalled();
    });

    it("falls back to feed content when Readability extraction looks like homepage", async () => {
      const homepageHtml = `
        <!DOCTYPE html>
        <html>
        <head><title>My Blog</title></head>
        <body>
          <nav>
            <a href="/1">Link 1</a> <a href="/2">Link 2</a>
            <a href="/3">Link 3</a> <a href="/4">Link 4</a>
            <a href="/5">Link 5</a> <a href="/6">Link 6</a>
            <a href="/7">Link 7</a> <a href="/8">Link 8</a>
            <a href="/9">Link 9</a> <a href="/10">Link 10</a>
            <a href="/11">Link 11</a> <a href="/12">Link 12</a>
          </nav>
        </body>
        </html>`;

      const item = makeFeedItem({
        title: "Specific Article Title",
        content: "<p>Fallback feed content that is available</p>",
      });
      (fetcher.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        homepageHtml,
      );

      const result = await service.fetchAndSave(item, "sub1", "Blog");

      // Should fall back to feed content
      expect(result).not.toBeNull();
      expect(result!.content).toContain("Fallback feed content");
    });

    it("handles canonical URL correction", async () => {
      // First fetch returns HTML with canonical pointing to homepage
      const htmlWithHomepageCanonical = `
        <!DOCTYPE html>
        <html>
        <head>
          <link rel="canonical" href="https://example.com/">
          <title>Homepage</title>
        </head>
        <body><p>Homepage content</p></body>
        </html>`;

      const fetchMock = fetcher.fetch as ReturnType<typeof vi.fn>;
      fetchMock
        .mockResolvedValueOnce(htmlWithHomepageCanonical) // first call
        .mockResolvedValueOnce(ARTICLE_HTML); // retry with corrected URL

      const item = makeFeedItem({
        link: "https://example.com/blog/my-post",
      });

      const result = await service.fetchAndSave(item, "sub1", "Blog");

      // Should have made two fetch calls
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Second call should be with corrected URL (slug at root)
      expect(fetchMock).toHaveBeenCalledWith("https://example.com/my-post/");
    });

    it("fetches the page when feed content ends in a 'Read more' link", async () => {
      const preview =
        "<p>" + "Preview prose. ".repeat(35) + "</p>" +
        '<p><a href="https://example.com/post-1">Read more</a></p>';
      const item = makeFeedItem({ content: preview });
      (fetcher.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(LONG_ARTICLE_HTML);

      const result = await service.fetchAndSave(item, "sub1", "Blog");

      expect(fetcher.fetch).toHaveBeenCalledWith(item.link);
      expect(result).not.toBeNull();
      expect(result!.content).toContain("continues well past where the feed preview stopped");
      expect(result!.content).not.toContain("Read more");
    });

    it("skips the article when the fetched page is still truncated", async () => {
      const preview =
        "<p>" + "Preview prose. ".repeat(40) + "</p>" +
        '<p><a href="https://example.com/post-1">Read more</a></p>';
      const item = makeFeedItem({ content: preview });
      // Fetch fails, so the truncated preview is all we have.
      (fetcher.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await service.fetchAndSave(item, "sub1", "Blog");

      expect(result).toBeNull();
      expect(repo.put).not.toHaveBeenCalled();
    });

    it("skips when the fetched page carries a paywall widget", async () => {
      // Readability strips the widget, so the extracted body would otherwise
      // look complete — the raw-HTML check is what catches this.
      const preview =
        "<p>" + "Preview prose. ".repeat(35) + "</p>" +
        '<p><a href="https://example.com/post-1">Read more</a></p>';
      const item = makeFeedItem({ content: preview });
      const walled = LONG_ARTICLE_HTML.replace(
        "</article>",
        '</article><div data-testid="paywall" class="paywall"><h2 class="paywall-title">Continue reading this post for free.</h2></div>',
      );
      (fetcher.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(walled);

      const result = await service.fetchAndSave(item, "sub1", "Blog");

      expect(result).toBeNull();
      expect(repo.put).not.toHaveBeenCalled();
    });

    it("skips paywalled articles", async () => {
      const stub =
        "<p>" + "The opening paragraph everyone can read. ".repeat(15) + "</p>" +
        "<p>This post is for paid subscribers</p>";
      const item = makeFeedItem({ content: stub });
      (fetcher.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await service.fetchAndSave(item, "sub1", "Blog");

      expect(result).toBeNull();
      expect(repo.put).not.toHaveBeenCalled();
    });

    it("keeps the longer feed preview when the fetched page yields less text", async () => {
      const preview =
        "<p>" + "Substantially longer preview prose. ".repeat(60) + "</p>" +
        '<p><a href="https://example.com/post-1">Read more</a></p>';
      const item = makeFeedItem({ content: preview });
      (fetcher.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(ARTICLE_HTML);

      const result = await service.fetchAndSave(item, "sub1", "Blog");

      // The fetched page is shorter than the preview, so it is not a rescue —
      // and the preview itself is truncated, so nothing ships.
      expect(result).toBeNull();
    });

    it("does not fetch when the feed already carries the whole article", async () => {
      const item = makeFeedItem({ content: "<p>" + "A".repeat(600) + "</p>" });

      const result = await service.fetchAndSave(item, "sub1", "Blog");

      expect(result).not.toBeNull();
      expect(fetcher.fetch).not.toHaveBeenCalled();
    });

    it("saves article with correct metadata", async () => {
      const longContent =
        "<p>" + "B".repeat(600) + "</p>";
      const item = makeFeedItem({
        title: "My Great Post",
        content: longContent,
      });

      const result = await service.fetchAndSave(item, "sub1", "Test Blog");

      expect(result).not.toBeNull();
      expect(result!.feedId).toBe("sub1");
      expect(result!.feedTitle).toBe("Test Blog");
      expect(result!.title).toBe("My Great Post");
      expect(result!.id).toMatch(/^[a-f0-9]{16}$/);
    });

    it("credits the feed's author on the inline-content path", async () => {
      const item = makeFeedItem({
        content: "<p>" + "B".repeat(600) + "</p>",
        author: "Jane Doe",
      });

      const result = await service.fetchAndSave(item, "sub1", "Blog");

      // This path never fetches the page, so the feed is the only author source.
      expect(fetcher.fetch).not.toHaveBeenCalled();
      expect(result!.byline).toBe("Jane Doe");
    });

    it("prefers the page's author over the feed's when it fetched the page", async () => {
      const item = makeFeedItem({ content: "<p>Short</p>", author: "Feed Bot" });
      (fetcher.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        ARTICLE_HTML.replace(
          "<head>",
          `<head><meta name="author" content="Jane Doe">`,
        ),
      );

      const result = await service.fetchAndSave(item, "sub1", "Blog");

      expect(result!.byline).toBe("Jane Doe");
    });

    it("keeps the feed's author when the fetched page names none", async () => {
      const item = makeFeedItem({ content: "<p>Short</p>", author: "Jane Doe" });
      (fetcher.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(ARTICLE_HTML);

      const result = await service.fetchAndSave(item, "sub1", "Blog");

      expect(result!.byline).toBe("Jane Doe");
    });

    it("leaves the byline empty rather than storing a sentinel", async () => {
      const item = makeFeedItem({ content: "<p>" + "B".repeat(600) + "</p>" });

      const result = await service.fetchAndSave(item, "sub1", "Blog");

      expect(result!.byline).toBe("");
    });
  });

  describe("getArticle", () => {
    it("delegates to repo.get", async () => {
      const article = {
        id: "abc123",
        url: "https://example.com/post",
        title: "Test",
        byline: "Author",
        content: "<p>content</p>",
        savedAt: Date.now(),
        feedId: "sub1",
        feedTitle: "Blog",
      };
      (repo.get as ReturnType<typeof vi.fn>).mockResolvedValue(article);

      const result = await service.getArticle("abc123");
      expect(result).toEqual(article);
      expect(repo.get).toHaveBeenCalledWith("abc123");
    });
  });
});
