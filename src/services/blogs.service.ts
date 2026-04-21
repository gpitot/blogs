import type {
  SubscriptionRepo,
  Subscription,
  PopularSubscription,
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
    userId: string,
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

    const existing = await this.subs.listForUser(userId);
    if (existing.some((s) => s.feedUrl === feedUrl)) {
      return { error: "You are already subscribed to this feed." };
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
      userId,
      feedUrl,
      siteUrl: url,
      title: feed.title || url,
      addedAt: Date.now(),
      lastChecked: null,
      seenGuids: [],
      convertedArticles: [],
    };

    await this.subs.put(sub);
    await this.subs.incrementPopular(feedUrl, url, sub.title);
    logger.info({ title: sub.title, feedUrl }, "Subscribed to feed");
    return { subscription: sub };
  }

  async unsubscribe(id: string): Promise<void> {
    const sub = await this.subs.get(id);
    await this.subs.delete(id);
    if (sub) {
      await this.subs.decrementPopular(sub.feedUrl);
    }
    logger.info({ id }, "Unsubscribed");
  }

  async listSubscriptions(userId: string): Promise<Subscription[]> {
    const subs = await this.subs.listForUser(userId);
    return subs.sort((a, b) => b.addedAt - a.addedAt);
  }

  async getPopularSubscriptions(): Promise<PopularSubscription[]> {
    return this.subs.getPopular();
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
