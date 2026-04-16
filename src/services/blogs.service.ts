import type {
  SubscriptionRepo,
  Subscription,
} from "../repositories/types.ts";
import { MAX_SEEN_GUIDS } from "../repositories/types.ts";
import type { FeedClient } from "./interfaces.ts";
import type { FeedItem } from "./rss.ts";
import { generateId } from "../utils.ts";
import { createLogger } from "../logger.ts";

const logger = createLogger("blogs-service");

export class BlogsService {
  constructor(
    private subs: SubscriptionRepo,
    private feed: FeedClient,
  ) {}

  async subscribe(
    url: string,
  ): Promise<{ subscription: Subscription } | { error: string }> {
    logger.info({ url }, "Detecting feed URL");
    const feedUrl = await this.feed.detectFeedUrl(url);
    if (!feedUrl) {
      logger.warn({ url }, "No feed found for URL");
      return {
        error:
          "Could not find an RSS or Atom feed for that URL. Please provide the feed URL directly.",
      };
    }

    let feed;
    try {
      feed = await this.feed.fetchAndParseFeed(feedUrl);
    } catch (err) {
      logger.error({ err, feedUrl }, "Failed to fetch feed");
      return {
        error: `Failed to read feed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const sub: Subscription = {
      id: generateId(),
      feedUrl,
      siteUrl: url,
      title: feed.title || url,
      addedAt: Date.now(),
      lastChecked: null,
      seenGuids: [],
      convertedArticles: [],
    };

    await this.subs.put(sub);
    logger.info({ title: sub.title, feedUrl }, "Subscribed to feed");
    return { subscription: sub };
  }

  async unsubscribe(id: string): Promise<void> {
    logger.info({ id }, "Unsubscribed");
    await this.subs.delete(id);
  }

  async listSubscriptions(): Promise<Subscription[]> {
    return this.subs.list();
  }

  async checkForNewPosts(sub: Subscription): Promise<FeedItem[]> {
    const feed = await this.feed.fetchAndParseFeed(sub.feedUrl);

    const seenSet = new Set(sub.seenGuids);
    const newItems = feed.items
      .filter((item) => !seenSet.has(item.guid))
      .sort((a, b) => b.pubDate - a.pubDate)
      .slice(0, 5);

    const newGuids = newItems.map((item) => item.guid);

    await this.subs.put({
      ...sub,
      lastChecked: Date.now(),
      seenGuids: [...newGuids, ...sub.seenGuids].slice(0, MAX_SEEN_GUIDS),
    });

    logger.debug({ sub: sub.title, newItems: newItems.length }, "Checked feed for new posts");
    return newItems;
  }

}
