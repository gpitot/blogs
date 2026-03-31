import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryKV } from "../helpers/memory-kv.ts";
import { KvArticleRepo, KvEpubRepo } from "../../repositories/kv.ts";
import { PostsService } from "../../services/posts.service.ts";
import { ConversionService } from "../../services/conversion.service.ts";
import type { HtmlFetcher, ImageProcessor } from "../../services/interfaces.ts";
import type { PendingArticle } from "../../repositories/types.ts";
import { urlToKey } from "../../utils.ts";

const ARTICLE_HTML = `
<!DOCTYPE html>
<html>
<head><title>Test Article</title></head>
<body>
  <article>
    <h1>Test Article</h1>
    <p>This is a substantial article with enough content for Readability.</p>
    <p>More content to ensure proper extraction. The article discusses various topics.</p>
    <p>A third paragraph to really drive the point home about this article.</p>
  </article>
</body>
</html>`;

describe("Convert flow (integration)", () => {
  let posts: PostsService;
  let conversion: ConversionService;
  let kv: MemoryKV;

  beforeEach(() => {
    kv = new MemoryKV();
    const kvNs = kv as unknown as KVNamespace;
    const htmlFetcher: HtmlFetcher = {
      fetch: vi.fn().mockResolvedValue(ARTICLE_HTML),
    };
    const imageProcessor: ImageProcessor = {
      processArticleImages: vi.fn().mockResolvedValue({
        html: "<p>processed content</p>",
        images: [],
      }),
    };

    posts = new PostsService(new KvArticleRepo(kvNs), htmlFetcher);
    conversion = new ConversionService(new KvEpubRepo(kvNs), imageProcessor);
  });

  it("single article conversion → cache → re-download", async () => {
    const url = "https://example.com/test-article";

    // Convert
    const result = await conversion.convertSingleArticle(url, ARTICLE_HTML);
    expect(result.cacheKey).toMatch(/^epub:[a-f0-9]+$/);
    expect(result.epubBytes.byteLength).toBeGreaterThan(0);

    // Check cache hit
    const cached = await conversion.getCachedConversion(result.cacheKey);
    expect(cached).not.toBeNull();
    expect(cached!.title).toBe("Test Article");
    expect(cached!.size).toBe(result.epubBytes.byteLength);

    // Re-download the EPUB data
    const epubData = await conversion.getEpubData(cached!.kvKey);
    expect(epubData).not.toBeNull();
    expect((epubData as ArrayBuffer).byteLength).toBe(
      result.epubBytes.byteLength,
    );
  });

  it("urlToKey produces consistent cache keys", async () => {
    const url = "https://example.com/test";
    const key1 = await urlToKey(url);
    const key2 = await urlToKey(url);
    expect(key1).toBe(key2);
    expect(key1).toMatch(/^epub:[a-f0-9]+$/);
  });

  it("pending article conversion to EPUB", async () => {
    const article: PendingArticle = {
      id: "test-article-1",
      url: "https://example.com/post",
      title: "Test Post",
      byline: "Author Name",
      content: "<p>Article content here</p>",
      savedAt: Date.now(),
      subId: "sub1",
      subTitle: "Test Blog",
    };

    // Store the article
    const articleRepo = new KvArticleRepo(kv as unknown as KVNamespace);
    await articleRepo.put(article);

    // Retrieve it
    const retrieved = await posts.getArticle(article.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.title).toBe("Test Post");

    // Convert to EPUB
    const epubBytes = await conversion.convertArticleToEpub(article);
    expect(epubBytes).toBeInstanceOf(Uint8Array);
    expect(epubBytes.byteLength).toBeGreaterThan(0);
    // EPUB/ZIP header
    expect(epubBytes[0]).toBe(0x50);
    expect(epubBytes[1]).toBe(0x4b);
  });
});
