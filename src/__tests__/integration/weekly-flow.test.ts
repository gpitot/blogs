import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryKV } from "../helpers/memory-kv.ts";
import { KvSubscriptionRepo, KvArticleRepo, KvEpubRepo } from "../../repositories/kv.ts";
import { BlogsService } from "../../services/blogs.service.ts";
import { PostsService } from "../../services/posts.service.ts";
import { ConversionService } from "../../services/conversion.service.ts";
import type { FeedClient, HtmlFetcher, ImageProcessor } from "../../services/interfaces.ts";
import type { FeedItem } from "../../services/rss.ts";

function makeFeedItems(count: number): FeedItem[] {
  return Array.from({ length: count }, (_, i) => ({
    guid: `guid-${i}`,
    title: `Post ${i}`,
    link: `https://example.com/post-${i}`,
    pubDate: Date.now() - i * 86400000,
    content: "<p>" + "Article content ".repeat(40) + "</p>",
  }));
}

describe("Weekly flow (integration)", () => {
  let blogs: BlogsService;
  let posts: PostsService;
  let conversion: ConversionService;

  beforeEach(() => {
    const kv = new MemoryKV() as unknown as KVNamespace;
    const feedClient: FeedClient = {
      detectFeedUrl: vi.fn().mockResolvedValue("https://example.com/feed"),
      fetchAndParseFeed: vi.fn().mockResolvedValue({
        title: "Test Blog",
        items: makeFeedItems(3),
      }),
    };
    const htmlFetcher: HtmlFetcher = {
      fetch: vi.fn().mockResolvedValue(null),
    };
    const imageProcessor: ImageProcessor = {
      processArticleImages: vi.fn().mockResolvedValue({
        html: "<p>processed</p>",
        images: [],
      }),
    };

    blogs = new BlogsService(new KvSubscriptionRepo(kv), feedClient);
    posts = new PostsService(new KvArticleRepo(kv), htmlFetcher);
    conversion = new ConversionService(new KvEpubRepo(kv), imageProcessor);
  });

  it("full weekly job: subscribe → check → save articles → compile book", async () => {
    // 1. Subscribe
    const subResult = await blogs.subscribe("https://example.com");
    expect(subResult).toHaveProperty("subscription");
    const sub = (subResult as { subscription: any }).subscription;

    // 2. Check for new posts
    const newItems = await blogs.checkForNewPosts(sub);
    expect(newItems.length).toBeGreaterThan(0);

    // 3. Save each article
    const savedArticles = [];
    for (const item of newItems) {
      const article = await posts.fetchAndSave(item, sub.id, sub.title);
      if (article) savedArticles.push(article);
    }
    expect(savedArticles.length).toBeGreaterThan(0);

    // 4. Update recent articles
    await blogs.updateRecentArticles(sub, savedArticles);

    // 5. Verify articles are stored and retrievable
    for (const article of savedArticles) {
      const retrieved = await posts.getArticle(article.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.title).toBe(article.title);
    }

    // 6. Compile weekly book
    const bookMeta = await conversion.compileWeeklyBook(savedArticles);
    expect(bookMeta).not.toBeNull();
    expect(bookMeta!.articleCount).toBe(savedArticles.length);
    expect(bookMeta!.weekKey).toMatch(/^\d{4}-W\d{2}$/);

    // 7. Verify weekly book is stored and retrievable
    const books = await conversion.listWeeklyBooks();
    expect(books).toHaveLength(1);
    expect(books[0].weekKey).toBe(bookMeta!.weekKey);

    const bookData = await conversion.getWeeklyBook(bookMeta!.weekKey);
    expect(bookData).not.toBeNull();
    expect(bookData!.buf.byteLength).toBeGreaterThan(0);
    // EPUB starts with PK zip signature
    const bytes = new Uint8Array(bookData!.buf);
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it("skips book generation when no new articles", async () => {
    const result = await conversion.compileWeeklyBook([]);
    expect(result).toBeNull();

    const books = await conversion.listWeeklyBooks();
    expect(books).toHaveLength(0);
  });
});
