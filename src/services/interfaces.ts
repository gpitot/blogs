import type { ParsedFeed } from "./rss.ts";
import type { EpubImage } from "./images.ts";

export interface FeedClient {
  detectFeedUrl(url: string): Promise<string | null>;
  fetchAndParseFeed(feedUrl: string): Promise<ParsedFeed>;
}

export interface HtmlFetcher {
  fetch(url: string): Promise<string | null>;
}

export interface ImageProcessor {
  processArticleImages(
    html: string,
    baseUrl: string,
    startIndex?: number,
  ): Promise<{ html: string; images: EpubImage[] }>;
}
