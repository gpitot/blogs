import type { ArticleRepo, PendingArticle } from "../repositories/types.ts";
import type { HtmlFetcher } from "./interfaces.ts";
import type { FeedItem } from "./rss.ts";
import type { ExtractedArticle } from "./clean.ts";
import {
  extractArticle,
  extractArticleFromFeedContent,
  extractCanonicalUrl,
} from "./clean.ts";
import { classifyCompleteness, detectRawPaywall, textLength } from "./truncation.ts";
import { resolveAuthor } from "./author.ts";
import { generateId } from "../utils.ts";
import { createLogger } from "../logger.ts";

const logger = createLogger("posts-service");

type FetchResult =
  | { kind: "article"; article: ExtractedArticle; url: string }
  | { kind: "paywalled"; evidence: string }
  | { kind: "unavailable" };

export class PostsService {
  constructor(
    private articles: ArticleRepo,
    private fetcher: HtmlFetcher,
  ) {}

  async fetchAndSave(
    item: FeedItem,
    feedId: string,
    feedTitle: string,
  ): Promise<PendingArticle | null> {
    let article: ExtractedArticle | null = null;
    let articleUrl = item.link;

    if (item.content && item.content.length >= 500) {
      article = extractArticleFromFeedContent(
        item.content,
        item.title,
        item.link,
        item.author,
      );

      // A long feed body is not necessarily the whole article — Substack ships
      // multi-thousand-word previews that end at a "Read more" link. Only when
      // the body looks cut short do we pay for the page fetch.
      if (classifyCompleteness(article.content, articleUrl).kind !== "complete") {
        const fetched = await this.fetchAndExtract(item.link, item.title);

        if (fetched.kind === "paywalled") {
          return this.skip(item, articleUrl, "paywalled", fetched.evidence);
        }
        if (
          fetched.kind === "article" &&
          classifyCompleteness(fetched.article.content, fetched.url).kind === "complete" &&
          textLength(fetched.article.content) >= textLength(article.content)
        ) {
          article = fetched.article;
          articleUrl = fetched.url;
        }
      }
    } else {
      const fetched = await this.fetchAndExtract(item.link, item.title);

      if (fetched.kind === "paywalled") {
        return this.skip(item, item.link, "paywalled", fetched.evidence);
      }
      if (fetched.kind === "article") {
        article = fetched.article;
        articleUrl = fetched.url;
      }

      if (!article && item.content) {
        article = extractArticleFromFeedContent(
          item.content,
          item.title,
          item.link,
          item.author,
        );
        articleUrl = item.link;
      }
    }

    if (!article || !article.content) {
      logger.warn({ title: item.title }, "No content available for article, skipping");
      return null;
    }

    // Whatever body we settled on, refuse to ship a partial one.
    const completeness = classifyCompleteness(article.content, articleUrl);
    if (completeness.kind !== "complete") {
      return this.skip(item, articleUrl, completeness.kind, completeness.evidence);
    }

    const pending: PendingArticle = {
      id: generateId(),
      url: articleUrl,
      title: article.title || item.title || "Article",
      // Left empty when genuinely unknown: the article carries feedTitle, so
      // the fallback is better chosen at display time than frozen in here.
      byline: resolveAuthor(article.byline, item.author, article.siteName),
      content: article.content,
      savedAt: Date.now(),
      feedId,
      feedTitle,
    };

    await this.articles.put(pending);
    logger.info({ title: pending.title, url: pending.url, feedTitle }, "Article fetched and saved");
    return pending;
  }

  async getArticle(id: string): Promise<PendingArticle | null> {
    return this.articles.get(id);
  }

  /** Logs why an article is being dropped, so false positives stay visible. */
  private skip(
    item: FeedItem,
    url: string,
    verdict: string,
    evidence: string,
  ): null {
    logger.info(
      { title: item.title, url, verdict, evidence },
      "Skipping incomplete article",
    );
    return null;
  }

  /**
   * Fetches a page and runs Readability over it, following a homepage canonical
   * to the real post URL when the feed link points at one. Returns null when the
   * fetch fails or the extracted content doesn't look like the expected article.
   */
  private async fetchAndExtract(
    url: string,
    expectedTitle: string,
  ): Promise<FetchResult> {
    const html = await this.fetcher.fetch(url);
    if (!html) return { kind: "unavailable" };

    let article: ExtractedArticle | null = null;
    let resolvedUrl = url;
    let pageHtml = html;

    const canonical = extractCanonicalUrl(html);
    const correctedUrl = canonical ? this.deriveCorrectUrl(url, canonical) : null;

    if (correctedUrl) {
      logger.debug(
        { feedUrl: url, correctedUrl },
        "Feed URL has homepage canonical, retrying",
      );
      const retryHtml = await this.fetcher.fetch(correctedUrl);
      if (retryHtml) {
        pageHtml = retryHtml;
        article = extractArticle(retryHtml, correctedUrl);
        resolvedUrl = correctedUrl;
      }
    } else {
      article = extractArticle(html, url);
    }

    // Must be judged on the raw page: Readability discards the paywall widget,
    // leaving an extracted body that looks complete but stops at the wall.
    const paywall = detectRawPaywall(pageHtml);
    if (paywall) return { kind: "paywalled", evidence: paywall };

    if (article && !this.looksLikeArticle(article, expectedTitle)) {
      logger.debug(
        { expected: expectedTitle, extracted: article.title },
        "Readability extracted wrong content, discarding",
      );
      article = null;
    }

    return article ? { kind: "article", article, url: resolvedUrl } : { kind: "unavailable" };
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
