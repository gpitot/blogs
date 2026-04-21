import type {
  FeedRepo,
  UserSubscriptionRepo,
  Feed,
  PopularSubscription,
} from "../repositories/types.ts";
import { MAX_SEEN_GUIDS } from "../repositories/types.ts";
import type { FeedClient } from "./interfaces.ts";
import type { FeedItem } from "./rss.ts";
import { feedUrlToId } from "../utils.ts";
import { createLogger } from "../logger.ts";

const logger = createLogger("blogs-service");

export interface SubscriptionView {
  feedId: string;
  feedUrl: string;
  siteUrl: string;
  title: string;
  addedAt: number;
  lastChecked: number | null;
  convertedArticles: Feed["convertedArticles"];
}

export class BlogsService {
  constructor(
    private feeds: FeedRepo,
    private userSubs: UserSubscriptionRepo,
    private feedClient: FeedClient,
  ) {}

  async subscribe(
    userId: string,
    url: string,
  ): Promise<{ subscription: SubscriptionView } | { error: string }> {
    logger.info({ url }, "Detecting feed URL");
    const feedUrl = await this.feedClient.detectFeedUrl(url);
    if (!feedUrl) {
      logger.warn({ url }, "No feed found for URL");
      return {
        error:
          "Could not find an RSS or Atom feed for that URL. Please provide the feed URL directly.",
      };
    }

    const feedId = await feedUrlToId(feedUrl);
    const alreadySubscribed = await this.userSubs.isSubscribed(userId, feedId);
    if (alreadySubscribed) {
      return { error: "You are already subscribed to this feed." };
    }

    let existingFeed = await this.feeds.get(feedId);

    if (!existingFeed) {
      let parsedFeed;
      try {
        parsedFeed = await this.feedClient.fetchAndParseFeed(feedUrl);
      } catch (err) {
        logger.error({ err, feedUrl }, "Failed to fetch feed");
        return {
          error: `Failed to read feed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      existingFeed = {
        id: feedId,
        feedUrl,
        siteUrl: url,
        title: parsedFeed.title || url,
        lastChecked: null,
        seenGuids: [],
        convertedArticles: [],
      };
      await this.feeds.put(existingFeed);
    }

    await this.userSubs.subscribe(userId, feedId);
    await this.feeds.incrementPopular(feedUrl, existingFeed.siteUrl, existingFeed.title);
    logger.info({ title: existingFeed.title, feedUrl }, "Subscribed to feed");

    return {
      subscription: {
        feedId: existingFeed.id,
        feedUrl: existingFeed.feedUrl,
        siteUrl: existingFeed.siteUrl,
        title: existingFeed.title,
        addedAt: Date.now(),
        lastChecked: existingFeed.lastChecked,
        convertedArticles: existingFeed.convertedArticles,
      },
    };
  }

  async unsubscribe(userId: string, feedId: string): Promise<void> {
    const feed = await this.feeds.get(feedId);
    await this.userSubs.unsubscribe(userId, feedId);
    if (feed) {
      await this.feeds.decrementPopular(feed.feedUrl);
    }
    logger.info({ feedId }, "Unsubscribed");
  }

  async listSubscriptions(userId: string): Promise<SubscriptionView[]> {
    const subs = await this.userSubs.listForUser(userId);
    const views = await Promise.all(
      subs.map(async (sub) => {
        const feed = await this.feeds.get(sub.feedId);
        if (!feed) return null;
        return {
          feedId: feed.id,
          feedUrl: feed.feedUrl,
          siteUrl: feed.siteUrl,
          title: feed.title,
          addedAt: sub.addedAt,
          lastChecked: feed.lastChecked,
          convertedArticles: feed.convertedArticles,
        } satisfies SubscriptionView;
      }),
    );
    return views.filter((v): v is SubscriptionView => v !== null).sort((a, b) => b.addedAt - a.addedAt);
  }

  async getPopularSubscriptions(): Promise<PopularSubscription[]> {
    return this.feeds.getPopular();
  }

  async checkForNewPosts(feed: Feed): Promise<FeedItem[]> {
    const parsed = await this.feedClient.fetchAndParseFeed(feed.feedUrl);

    const seenSet = new Set(feed.seenGuids);
    const newItems = parsed.items
      .filter((item) => !seenSet.has(item.guid))
      .sort((a, b) => b.pubDate - a.pubDate)
      .slice(0, 5);

    const newGuids = newItems.map((item) => item.guid);

    await this.feeds.put({
      ...feed,
      lastChecked: Date.now(),
      seenGuids: [...newGuids, ...feed.seenGuids].slice(0, MAX_SEEN_GUIDS),
    });

    logger.debug({ feed: feed.title, newItems: newItems.length }, "Checked feed for new posts");
    return newItems;
  }
}
