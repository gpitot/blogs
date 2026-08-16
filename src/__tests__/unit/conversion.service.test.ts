import { describe, it, expect, vi, beforeEach } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { ConversionService } from "../../services/conversion.service.ts";
import type { EpubRepo, PendingArticle, WeeklyBookMeta } from "../../repositories/types.ts";
import type { ImageProcessor } from "../../services/interfaces.ts";

function mockEpubRepo(): EpubRepo {
  return {
    getCachedMeta: vi.fn().mockResolvedValue(null),
    putCachedMeta: vi.fn().mockResolvedValue(undefined),
    putEpubData: vi.fn().mockResolvedValue(undefined),
    getEpubData: vi.fn().mockResolvedValue(null),
    listWeeklyBooks: vi.fn().mockResolvedValue([]),
    addWeeklyBook: vi.fn().mockResolvedValue(undefined),
    getWeeklyBookData: vi.fn().mockResolvedValue(null),
    listCachedArticles: vi.fn().mockResolvedValue([]),
    addCachedArticle: vi.fn().mockResolvedValue(undefined),
  };
}

function mockImageProcessor(): ImageProcessor {
  return {
    processArticleImages: vi.fn().mockResolvedValue({
      html: "<p>processed content</p>",
      images: [],
    }),
  };
}

function makeArticle(overrides?: Partial<PendingArticle>): PendingArticle {
  return {
    id: "art1",
    url: "https://example.com/post-1",
    title: "Test Article",
    byline: "Test Author",
    content: "<p>Article content</p>",
    savedAt: Date.now(),
    feedId: "sub1",
    feedTitle: "Test Blog",
    ...overrides,
  };
}

// Minimal HTML that Readability can extract
const ARTICLE_HTML = `
<!DOCTYPE html>
<html>
<head><title>Test Article</title></head>
<body>
  <article>
    <h1>Test Article</h1>
    <p>This is the main article content. It needs to be long enough for Readability to consider it worth extracting. Here is some more text to make it substantial enough.</p>
    <p>Another paragraph of content that adds more substance to the article.</p>
    <p>A third paragraph to ensure proper extraction by Readability.</p>
  </article>
</body>
</html>`;

describe("ConversionService", () => {
  let repo: EpubRepo;
  let images: ImageProcessor;
  let service: ConversionService;

  beforeEach(() => {
    repo = mockEpubRepo();
    images = mockImageProcessor();
    service = new ConversionService(repo, images);
  });

  describe("convertSingleArticle", () => {
    it("extracts article, processes images, generates EPUB, and caches", async () => {
      const result = await service.convertSingleArticle(
        "https://example.com/post",
        ARTICLE_HTML,
        "user1",
      );

      expect(result.cacheKey).toMatch(/^epub:[a-f0-9]+$/);
      expect(result.epubBytes).toBeInstanceOf(Uint8Array);
      expect(result.epubBytes.byteLength).toBeGreaterThan(0);

      expect(images.processArticleImages).toHaveBeenCalled();
      expect(repo.putEpubData).toHaveBeenCalled();
      expect(repo.putCachedMeta).toHaveBeenCalled();
    });

    it("generates valid EPUB bytes (starts with PK zip header)", async () => {
      const result = await service.convertSingleArticle(
        "https://example.com/post",
        ARTICLE_HTML,
        "user1",
      );

      // EPUB is a ZIP file, so it starts with PK (0x50, 0x4B)
      expect(result.epubBytes[0]).toBe(0x50);
      expect(result.epubBytes[1]).toBe(0x4b);
    });
  });

  describe("convertArticleToEpub", () => {
    it("returns EPUB bytes for a pending article", async () => {
      const article = makeArticle();
      const bytes = await service.convertArticleToEpub(article);

      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.byteLength).toBeGreaterThan(0);
      expect(images.processArticleImages).toHaveBeenCalledWith(
        article.content,
        article.url,
      );
    });
  });

  describe("compileWeeklyBook", () => {
    it("returns null for empty articles array", async () => {
      const result = await service.compileWeeklyBook([], "user1");
      expect(result).toBeNull();
      expect(repo.addWeeklyBook).not.toHaveBeenCalled();
    });

    it("produces multi-chapter EPUB and stores it", async () => {
      const articles = [
        makeArticle({ id: "a1", title: "Article 1", feedTitle: "Blog A" }),
        makeArticle({ id: "a2", title: "Article 2", feedTitle: "Blog B" }),
      ];

      const result = await service.compileWeeklyBook(articles, "user1");

      expect(result).not.toBeNull();
      expect(result!.articleCount).toBe(2);
      expect(result!.title).toContain("Weekly Reading");
      expect(result!.weekKey).toMatch(/^\d{4}-W\d{2}$/);
      expect(repo.addWeeklyBook).toHaveBeenCalled();

      // Check the stored EPUB data — addWeeklyBook(userId, meta, data)
      const [, meta, data] = (repo.addWeeklyBook as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(meta.articleCount).toBe(2);
      expect(data).toBeInstanceOf(Uint8Array);
    });

    it("handles image processing failures gracefully", async () => {
      (images.processArticleImages as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error("WASM failure"))
        .mockResolvedValueOnce({ html: "<p>ok</p>", images: [] });

      const articles = [
        makeArticle({ id: "a1", title: "Fails Images" }),
        makeArticle({ id: "a2", title: "Works Fine" }),
      ];

      const result = await service.compileWeeklyBook(articles, "user1");

      expect(result).not.toBeNull();
      expect(result!.articleCount).toBe(2);
    });

    it("processes images with correct startIndex for accumulation", async () => {
      const processMock = images.processArticleImages as ReturnType<typeof vi.fn>;
      processMock
        .mockResolvedValueOnce({
          html: "<p>a</p>",
          images: [
            { filename: "img001.jpg", data: new Uint8Array(1), mediaType: "image/jpeg" },
            { filename: "img002.jpg", data: new Uint8Array(1), mediaType: "image/jpeg" },
          ],
        })
        .mockResolvedValueOnce({
          html: "<p>b</p>",
          images: [],
        });

      const articles = [
        makeArticle({ id: "a1" }),
        makeArticle({ id: "a2" }),
      ];

      await service.compileWeeklyBook(articles, "user1");

      // Second call should have startIndex = 2 (after first article's 2 images)
      expect(processMock).toHaveBeenNthCalledWith(
        2,
        articles[1].content,
        articles[1].url,
        2,
      );
    });
  });

  describe("getCachedConversion", () => {
    it("delegates to repo", async () => {
      const entry = {
        kvKey: "epub-data:abc",
        title: "Test",
        createdAt: Date.now(),
        size: 1234,
      };
      (repo.getCachedMeta as ReturnType<typeof vi.fn>).mockResolvedValue(entry);

      const result = await service.getCachedConversion("epub:abc");
      expect(result).toEqual(entry);
    });
  });

  describe("listWeeklyBooks", () => {
    it("delegates to repo", async () => {
      const books: WeeklyBookMeta[] = [
        {
          weekKey: "2026-W14",
          kvKey: "weekly-book-data:2026-W14",
          title: "Weekly Reading",
          createdAt: Date.now(),
          articleCount: 5,
          size: 10000,
        },
      ];
      (repo.listWeeklyBooks as ReturnType<typeof vi.fn>).mockResolvedValue(books);

      const result = await service.listWeeklyBooks("user1");
      expect(result).toEqual(books);
    });
  });

  describe("author credited in the EPUB", () => {
    /** Read the EPUB back so we assert what a reader's device would show. */
    function epubFile(bytes: Uint8Array, path: string): string {
      return strFromU8(unzipSync(bytes)[path]!);
    }

    async function weeklyEpub(articles: PendingArticle[]): Promise<Uint8Array> {
      await service.compileWeeklyBook(articles, "user1");
      const [, , bytes] = (repo.addWeeklyBook as ReturnType<typeof vi.fn>).mock
        .calls[0]!;
      return bytes as Uint8Array;
    }

    it("uses the byline for a subscription article", async () => {
      const bytes = await service.convertArticleToEpub(
        makeArticle({ byline: "Jane Doe" }),
      );
      expect(epubFile(bytes, "OEBPS/content.opf")).toContain("Jane Doe");
    });

    it("credits the publication when the article has no byline", async () => {
      const bytes = await service.convertArticleToEpub(
        makeArticle({ byline: "", feedTitle: "Cloudflare Blog" }),
      );
      const opf = epubFile(bytes, "OEBPS/content.opf");
      expect(opf).toContain("Cloudflare Blog");
      expect(opf).not.toContain("Unknown Author");
    });

    it("falls back to Unknown Author only when nothing identifies the source", async () => {
      const bytes = await service.convertArticleToEpub(
        makeArticle({ byline: "", feedTitle: "" }),
      );
      expect(epubFile(bytes, "OEBPS/content.opf")).toContain("Unknown Author");
    });

    it("credits meta[name=author] on a single-URL conversion", async () => {
      const html = ARTICLE_HTML.replace(
        "<head>",
        `<head><meta name="author" content="Jane Doe">`,
      );
      const { epubBytes } = await service.convertSingleArticle(
        "https://example.com/post",
        html,
        "user1",
      );
      expect(epubFile(epubBytes, "OEBPS/content.opf")).toContain("Jane Doe");
    });

    it("leaves weekly chapters to inherit Various Authors when unknown", async () => {
      const bytes = await weeklyEpub([
        makeArticle({ byline: "", feedTitle: "" }),
      ]);
      // The regression this guards: a per-chapter "Unknown Author" sentinel
      // used to shadow the book-level credit.
      expect(epubFile(bytes, "OEBPS/ch1.xhtml")).toContain("Various Authors");
      expect(epubFile(bytes, "OEBPS/ch1.xhtml")).not.toContain("Unknown Author");
    });

    it("credits the source blog on a weekly chapter that has no byline", async () => {
      const bytes = await weeklyEpub([
        makeArticle({ byline: "", feedTitle: "Cloudflare Blog" }),
      ]);
      expect(epubFile(bytes, "OEBPS/ch1.xhtml")).toContain("Cloudflare Blog");
    });
  });
});
