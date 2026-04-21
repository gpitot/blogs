import { describe, it, expect, vi, beforeEach } from "vitest";
import { BlogsService } from "../../services/blogs.service.ts";
import type { FeedRepo, UserSubscriptionRepo, Feed } from "../../repositories/types.ts";
import type { FeedClient } from "../../services/interfaces.ts";
import type { FeedItem } from "../../services/rss.ts";

function mockFeedRepo(): FeedRepo {
  return {
    get: vi.fn().mockResolvedValue(null),
    getByUrl: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    getPopular: vi.fn().mockResolvedValue([]),
    incrementPopular: vi.fn().mockResolvedValue(undefined),
    decrementPopular: vi.fn().mockResolvedValue(undefined),
  };
}

function mockUserSubRepo(): UserSubscriptionRepo {
  return {
    listForUser: vi.fn().mockResolvedValue([]),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    isSubscribed: vi.fn().mockResolvedValue(false),
    getSubscriberUserIds: vi.fn().mockResolvedValue([]),
  };
}

function mockFeedClient(overrides?: Partial<FeedClient>): FeedClient {
  return {
    detectFeedUrl: vi.fn().mockResolvedValue("https://example.com/feed"),
    fetchAndParseFeed: vi.fn().mockResolvedValue({
      title: "Test Blog",
      items: [],
    }),
    ...overrides,
  };
}

function makeFeedItems(count: number): FeedItem[] {
  return Array.from({ length: count }, (_, i) => ({
    guid: `guid-${i}`,
    title: `Post ${i}`,
    link: `https://example.com/post-${i}`,
    pubDate: Date.now() - i * 86400000,
    content: `<p>Content ${i}</p>`,
  }));
}

function makeFeed(overrides?: Partial<Feed>): Feed {
  return {
    id: "feedhash1",
    feedUrl: "https://example.com/feed",
    siteUrl: "https://example.com",
    title: "Test Blog",
    lastChecked: null,
    seenGuids: [],
    convertedArticles: [],
    ...overrides,
  };
}

describe("BlogsService", () => {
  let feedRepo: FeedRepo;
  let userSubRepo: UserSubscriptionRepo;
  let feedClient: FeedClient;
  let service: BlogsService;

  beforeEach(() => {
    feedRepo = mockFeedRepo();
    userSubRepo = mockUserSubRepo();
    feedClient = mockFeedClient();
    service = new BlogsService(feedRepo, userSubRepo, feedClient);
  });

  describe("subscribe", () => {
    it("returns error when feed not found", async () => {
      (feedClient.detectFeedUrl as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await service.subscribe("user1", "https://example.com");

      expect(result).toHaveProperty("error");
      expect((result as { error: string }).error).toContain(
        "Could not find an RSS or Atom feed",
      );
      expect(feedRepo.put).not.toHaveBeenCalled();
    });

    it("returns error when feed parsing fails", async () => {
      (feedClient.fetchAndParseFeed as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Network error"),
      );

      const result = await service.subscribe("user1", "https://example.com");

      expect(result).toHaveProperty("error");
      expect((result as { error: string }).error).toContain("Network error");
    });

    it("creates feed and user subscription for new feed", async () => {
      const result = await service.subscribe("user1", "https://example.com");

      expect(result).toHaveProperty("subscription");
      expect(feedRepo.put).toHaveBeenCalled();
      expect(userSubRepo.subscribe).toHaveBeenCalled();
      expect(feedRepo.incrementPopular).toHaveBeenCalled();
    });

    it("reuses existing feed when already present", async () => {
      const existingFeed = makeFeed({ convertedArticles: [{ cacheKey: "k", articleId: "a1", title: "Old Post", createdAt: 123 }] });
      (feedRepo.get as ReturnType<typeof vi.fn>).mockResolvedValue(existingFeed);

      const result = await service.subscribe("user2", "https://example.com");

      expect(result).toHaveProperty("subscription");
      // Should not re-create the feed
      expect(feedRepo.put).not.toHaveBeenCalled();
      expect(feedClient.fetchAndParseFeed).not.toHaveBeenCalled();
      expect(userSubRepo.subscribe).toHaveBeenCalled();
    });

    it("returns error when already subscribed", async () => {
      (userSubRepo.isSubscribed as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const result = await service.subscribe("user1", "https://example.com");

      expect(result).toHaveProperty("error");
      expect((result as { error: string }).error).toContain("already subscribed");
    });
  });

  describe("unsubscribe", () => {
    it("removes user subscription and decrements popular", async () => {
      const feed = makeFeed();
      (feedRepo.get as ReturnType<typeof vi.fn>).mockResolvedValue(feed);

      await service.unsubscribe("user1", "feedhash1");

      expect(userSubRepo.unsubscribe).toHaveBeenCalledWith("user1", "feedhash1");
      expect(feedRepo.decrementPopular).toHaveBeenCalledWith(feed.feedUrl);
    });
  });

  describe("listSubscriptions", () => {
    it("joins user subscriptions with feed data", async () => {
      const feed = makeFeed();
      (userSubRepo.listForUser as ReturnType<typeof vi.fn>).mockResolvedValue([
        { userId: "user1", feedId: "feedhash1", addedAt: 1000 },
      ]);
      (feedRepo.get as ReturnType<typeof vi.fn>).mockResolvedValue(feed);

      const result = await service.listSubscriptions("user1");

      expect(result).toHaveLength(1);
      expect(result[0].feedId).toBe("feedhash1");
      expect(result[0].title).toBe("Test Blog");
    });
  });

  describe("checkForNewPosts", () => {
    it("returns only unseen items", async () => {
      const feed = makeFeed({ seenGuids: ["guid-0", "guid-1"] });
      const items = makeFeedItems(5);
      (feedClient.fetchAndParseFeed as ReturnType<typeof vi.fn>).mockResolvedValue({
        title: "Test Blog",
        items,
      });

      const newItems = await service.checkForNewPosts(feed);

      expect(newItems).toHaveLength(3);
      expect(newItems.map((i) => i.guid)).toEqual([
        "guid-2",
        "guid-3",
        "guid-4",
      ]);
    });

    it("returns at most 5 items", async () => {
      const feed = makeFeed();
      const items = makeFeedItems(10);
      (feedClient.fetchAndParseFeed as ReturnType<typeof vi.fn>).mockResolvedValue({
        title: "Test Blog",
        items,
      });

      const newItems = await service.checkForNewPosts(feed);
      expect(newItems.length).toBeLessThanOrEqual(5);
    });

    it("updates seenGuids and lastChecked on the feed", async () => {
      const feed = makeFeed({ seenGuids: ["old-guid"] });
      const items = makeFeedItems(2);
      (feedClient.fetchAndParseFeed as ReturnType<typeof vi.fn>).mockResolvedValue({
        title: "Test Blog",
        items,
      });

      await service.checkForNewPosts(feed);

      expect(feedRepo.put).toHaveBeenCalled();
      const saved = (feedRepo.put as ReturnType<typeof vi.fn>).mock.calls[0][0] as Feed;
      expect(saved.lastChecked).toBeGreaterThan(0);
      expect(saved.seenGuids).toContain("guid-0");
      expect(saved.seenGuids).toContain("guid-1");
      expect(saved.seenGuids).toContain("old-guid");
    });

    it("returns empty array when all items are seen", async () => {
      const feed = makeFeed({
        seenGuids: ["guid-0", "guid-1", "guid-2"],
      });
      const items = makeFeedItems(3);
      (feedClient.fetchAndParseFeed as ReturnType<typeof vi.fn>).mockResolvedValue({
        title: "Test Blog",
        items,
      });

      const newItems = await service.checkForNewPosts(feed);
      expect(newItems).toHaveLength(0);
    });
  });
});
