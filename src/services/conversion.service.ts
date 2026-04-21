import type {
  EpubRepo,
  PendingArticle,
  CacheEntry,
  CachedArticleMeta,
  WeeklyBookMeta,
} from "../repositories/types.ts";
import type { ImageProcessor } from "./interfaces.ts";
import type { EpubImage } from "./images.ts";
import { extractArticle } from "./clean.ts";
import { generateEpub } from "./epub.ts";
import { urlToKey } from "../utils.ts";
import { createLogger } from "../logger.ts";

const logger = createLogger("conversion-service");

const EPUB_CACHE_TTL = 604800; // 7 days

export class ConversionService {
  constructor(
    private epubs: EpubRepo,
    private images: ImageProcessor,
  ) {}

  async convertSingleArticle(
    url: string,
    html: string,
    userId: string,
  ): Promise<{ cacheKey: string; epubBytes: Uint8Array; title: string }> {
    const cacheKey = await urlToKey(url);
    logger.debug({ url, cacheKey }, "Converting single article");

    const article = extractArticle(html, url);

    const { html: contentWithImages, images } =
      await this.images.processArticleImages(article.content, url);
    article.content = contentWithImages;

    const epubBytes = generateEpub(
      article.title || "Article",
      article.byline || "Unknown Author",
      [article],
      images,
    );

    const kvKey = `epub-data:${cacheKey.replace("epub:", "")}`;
    await this.epubs.putEpubData(kvKey, epubBytes, EPUB_CACHE_TTL);
    const title = article.title || "Article";
    const createdAt = Date.now();
    await this.epubs.putCachedMeta(cacheKey, {
      kvKey,
      title,
      createdAt,
      size: epubBytes.byteLength,
    });
    await this.epubs.addCachedArticle(userId, {
      cacheKey,
      title,
      url,
      createdAt,
      size: epubBytes.byteLength,
    });

    logger.info({ title, size: epubBytes.byteLength }, "Article converted and cached");
    return { cacheKey, epubBytes, title };
  }

  async convertAndCacheSubscriptionArticle(
    article: PendingArticle,
    userId: string,
  ): Promise<string> {
    const cacheKey = await urlToKey(article.url);
    const epubBytes = await this.convertArticleToEpub(article);
    const kvKey = `epub-data:${cacheKey.replace("epub:", "")}`;
    await this.epubs.putEpubData(kvKey, epubBytes, EPUB_CACHE_TTL);
    const createdAt = Date.now();
    await this.epubs.putCachedMeta(cacheKey, {
      kvKey,
      title: article.title,
      createdAt,
      size: epubBytes.byteLength,
    });
    await this.epubs.addCachedArticle(userId, {
      cacheKey,
      title: article.title,
      url: article.url,
      createdAt,
      size: epubBytes.byteLength,
    });
    logger.info({ title: article.title, size: epubBytes.byteLength }, "Subscription article converted and cached");
    return cacheKey;
  }

  async convertArticleToEpub(article: PendingArticle): Promise<Uint8Array> {
    const { html: contentWithImages, images } =
      await this.images.processArticleImages(article.content, article.url);

    return generateEpub(
      article.title,
      article.byline || "Unknown Author",
      [
        {
          title: article.title,
          byline: article.byline,
          content: contentWithImages,
        },
      ],
      images,
    );
  }

  async compileWeeklyBook(
    articles: PendingArticle[],
    userId: string,
  ): Promise<WeeklyBookMeta | null> {
    if (articles.length === 0) return null;

    const now = new Date();
    const weekNum = this.getISOWeekNumber(now).toString().padStart(2, "0");
    const weekKey = `${now.getUTCFullYear()}-W${weekNum}`;
    const bookTitle = `Weekly Reading – ${now.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    })}`;

    const chapters: Array<{
      title: string;
      byline: string;
      content: string;
    }> = [];
    const allImages: EpubImage[] = [];

    for (const article of articles) {
      try {
        const { html: contentWithImages, images } =
          await this.images.processArticleImages(
            article.content,
            article.url,
            allImages.length,
          );
        allImages.push(...images);
        chapters.push({
          title: `${article.subTitle}: ${article.title}`,
          byline: article.byline || "Unknown Author",
          content: contentWithImages,
        });
      } catch (err) {
        logger.warn(
          { err, url: article.url },
          "Image processing failed for article, using raw content",
        );
        chapters.push({
          title: `${article.subTitle}: ${article.title}`,
          byline: article.byline || "Unknown Author",
          content: article.content,
        });
      }
    }

    if (chapters.length === 0) return null;

    const epubBytes = generateEpub(
      bookTitle,
      "Various Authors",
      chapters,
      allImages,
    );

    const meta: WeeklyBookMeta = {
      weekKey,
      kvKey: `weekly-book-data:${weekKey}`,
      title: bookTitle,
      createdAt: Date.now(),
      articleCount: chapters.length,
      size: epubBytes.byteLength,
    };

    await this.epubs.addWeeklyBook(userId, meta, epubBytes);
    logger.info(
      { title: bookTitle, chapters: chapters.length, sizeKb: Math.round(epubBytes.byteLength / 1024) },
      "Weekly book compiled",
    );

    return meta;
  }

  async getCachedConversion(cacheKey: string): Promise<CacheEntry | null> {
    return this.epubs.getCachedMeta(cacheKey);
  }

  async getEpubData(kvKey: string): Promise<ArrayBuffer | null> {
    return this.epubs.getEpubData(kvKey);
  }

  async getWeeklyBook(
    userId: string,
    weekKey: string,
  ): Promise<{ meta: WeeklyBookMeta; buf: ArrayBuffer } | null> {
    return this.epubs.getWeeklyBookData(userId, weekKey);
  }

  async listWeeklyBooks(userId: string): Promise<WeeklyBookMeta[]> {
    return this.epubs.listWeeklyBooks(userId);
  }

  async listCachedArticles(userId: string): Promise<CachedArticleMeta[]> {
    return this.epubs.listCachedArticles(userId);
  }

  private getISOWeekNumber(date: Date): number {
    const d = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(
      ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
    );
  }
}
