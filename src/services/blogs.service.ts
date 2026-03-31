import type {
  SubscriptionRepo,
  Subscription,
} from "../repositories/types.ts";
import { MAX_SEEN_GUIDS, MAX_RECENT_ARTICLES } from "../repositories/types.ts";
import type { FeedClient } from "./interfaces.ts";
import type { FeedItem } from "./rss.ts";
import { generateId } from "../utils.ts";

export class BlogsService {
  constructor(
    private subs: SubscriptionRepo,
    private feed: FeedClient,
  ) {}

  async subscribe(
    url: string,
  ): Promise<{ subscription: Subscription } | { error: string }> {
    const feedUrl = await this.feed.detectFeedUrl(url);
    if (!feedUrl) {
      return {
        error:
          "Could not find an RSS or Atom feed for that URL. Please provide the feed URL directly.",
      };
    }

    let feed;
    try {
      feed = await this.feed.fetchAndParseFeed(feedUrl);
    } catch (err) {
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
      lastChecked: Date.now(),
      seenGuids: feed.items
        .sort((a, b) => b.pubDate - a.pubDate)
        .slice(5)
        .map((i) => i.guid)
        .slice(0, MAX_SEEN_GUIDS),
      recentArticles: [],
    };

    await this.subs.put(sub);
    return { subscription: sub };
  }

  async unsubscribe(id: string): Promise<void> {
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

    return newItems;
  }

  async updateRecentArticles(
    sub: Subscription,
    articles: Array<{ id: string; title: string; savedAt: number }>,
  ): Promise<void> {
    const newRecent = articles.map((a) => ({
      id: a.id,
      title: a.title,
      createdAt: a.savedAt,
    }));
    const current = await this.subs.get(sub.id);
    if (!current) return;
    await this.subs.put({
      ...current,
      recentArticles: [...newRecent, ...current.recentArticles].slice(
        0,
        MAX_RECENT_ARTICLES,
      ),
    });
  }
}
