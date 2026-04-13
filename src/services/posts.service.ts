import type { ArticleRepo, PendingArticle } from "../repositories/types.ts";
import type { HtmlFetcher } from "./interfaces.ts";
import type { FeedItem } from "./rss.ts";
import {
  extractArticle,
  extractArticleFromFeedContent,
  extractCanonicalUrl,
} from "./clean.ts";
import { generateId } from "../utils.ts";
import { createLogger } from "../logger.ts";

const logger = createLogger("posts-service");

export class PostsService {
  constructor(
    private articles: ArticleRepo,
    private fetcher: HtmlFetcher,
  ) {}

  async fetchAndSave(
    item: FeedItem,
    subId: string,
    subTitle: string,
  ): Promise<PendingArticle | null> {
    let article: { title: string; content: string; byline: string } | null =
      null;
    let articleUrl = item.link;

    if (item.content && item.content.length >= 500) {
      article = extractArticleFromFeedContent(
        item.content,
        item.title,
        item.link,
      );
    } else {
      const html = await this.fetcher.fetch(item.link);

      if (html) {
        const canonical = extractCanonicalUrl(html);
        const correctedUrl = canonical
          ? this.deriveCorrectUrl(item.link, canonical)
          : null;

        if (correctedUrl) {
          logger.debug(
            { feedUrl: item.link, correctedUrl },
            "Feed URL has homepage canonical, retrying",
          );
          const retryHtml = await this.fetcher.fetch(correctedUrl);
          if (retryHtml) {
            article = extractArticle(retryHtml, correctedUrl);
            articleUrl = correctedUrl;
          }
        } else {
          article = extractArticle(html, item.link);
        }

        if (article && !this.looksLikeArticle(article, item.title)) {
          logger.debug(
            { expected: item.title, extracted: article.title },
            "Readability extracted wrong content, discarding",
          );
          article = null;
        }
      }

      if (!article && item.content) {
        article = extractArticleFromFeedContent(
          item.content,
          item.title,
          item.link,
        );
      }
    }

    if (!article || !article.content) {
      logger.warn({ title: item.title }, "No content available for article, skipping");
      return null;
    }

    const pending: PendingArticle = {
      id: generateId(),
      url: articleUrl,
      title: article.title || item.title || "Article",
      byline: article.byline || "Unknown Author",
      content: article.content,
      savedAt: Date.now(),
      subId,
      subTitle,
    };

    await this.articles.put(pending);
    logger.info({ title: pending.title, url: pending.url, subTitle }, "Article fetched and saved");
    return pending;
  }

  async getArticle(id: string): Promise<PendingArticle | null> {
    return this.articles.get(id);
  }

  private deriveCorrectUrl(
    feedUrl: string,
    canonicalUrl: string,
  ): string | null {
    try {
      const canonical = new URL(canonicalUrl, feedUrl);
      if (canonical.pathname !== "/" && canonical.pathname !== "") return null;

      const feed = new URL(feedUrl);
      const segments = feed.pathname.split("/").filter(Boolean);
      if (segments.length === 0) return null;
      const slug = segments[segments.length - 1];

      const candidate = new URL(`/${slug}/`, feed.origin);
      if (candidate.href === feed.href) return null;
      return candidate.href;
    } catch {
      return null;
    }
  }

  private looksLikeArticle(
    extracted: { title: string; content: string },
    expectedTitle: string,
  ): boolean {
    const normalize = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const extractedNorm = normalize(extracted.title);
    const expectedNorm = normalize(expectedTitle);
    if (extractedNorm && expectedNorm && extractedNorm.includes(expectedNorm)) {
      return true;
    }
    if (extractedNorm && expectedNorm && expectedNorm.includes(extractedNorm)) {
      return true;
    }

    const textOnly = extracted.content.replace(/<[^>]+>/g, "");
    if (textOnly.length < 100) return false;

    const linkCount = (extracted.content.match(/<a /g) || []).length;
    if (linkCount > 10 && textOnly.length / linkCount < 50) return false;

    return true;
  }
}
