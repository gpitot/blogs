import { describe, it, expect, vi, beforeEach } from "vitest";
import { BlogsService } from "../../services/blogs.service.ts";
import type { SubscriptionRepo, Subscription } from "../../repositories/types.ts";
import type { FeedClient } from "../../services/interfaces.ts";
import type { FeedItem } from "../../services/rss.ts";

function mockSubRepo(): SubscriptionRepo {
  return {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
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

function makeSub(overrides?: Partial<Subscription>): Subscription {
  return {
    id: "sub1",
    feedUrl: "https://example.com/feed",
    siteUrl: "https://example.com",
    title: "Test Blog",
    addedAt: Date.now(),
    lastChecked: null,
    seenGuids: [],
    convertedArticles: [],
    ...overrides,
  };
}

describe("BlogsService", () => {
  let repo: SubscriptionRepo;
  let feed: FeedClient;
  let service: BlogsService;

  beforeEach(() => {
    repo = mockSubRepo();
    feed = mockFeedClient();
    service = new BlogsService(repo, feed);
  });

  describe("subscribe", () => {
    it("returns error when feed not found", async () => {
      (feed.detectFeedUrl as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await service.subscribe("https://example.com");

      expect(result).toHaveProperty("error");
      expect((result as { error: string }).error).toContain(
        "Could not find an RSS or Atom feed",
      );
      expect(repo.put).not.toHaveBeenCalled();
    });

    it("returns error when feed parsing fails", async () => {
      (feed.fetchAndParseFeed as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Network error"),
      );

      const result = await service.subscribe("https://example.com");

      expect(result).toHaveProperty("error");
      expect((result as { error: string }).error).toContain("Network error");
    });

    it("creates subscription with correct seenGuids — marks all but latest 5 as seen", async () => {
      const items = makeFeedItems(10);
      (feed.fetchAndParseFeed as ReturnType<typeof vi.fn>).mockResolvedValue({
        title: "Test Blog",
        items,
      });

      const result = await service.subscribe("https://example.com");

      expect(result).toHaveProperty("subscription");
      const sub = (result as { subscription: Subscription }).subscription;

      // Latest 5 (guid-0..guid-4) should NOT be in seenGuids
      // Older 5 (guid-5..guid-9) should be in seenGuids
      expect(sub.seenGuids).toHaveLength(5);
      expect(sub.seenGuids).toContain("guid-5");
      expect(sub.seenGuids).toContain("guid-9");
      expect(sub.seenGuids).not.toContain("guid-0");
      expect(sub.seenGuids).not.toContain("guid-4");

      expect(repo.put).toHaveBeenCalledWith(sub);
    });

    it("creates subscription with empty seenGuids when fewer than 5 items", async () => {
      const items = makeFeedItems(3);
      (feed.fetchAndParseFeed as ReturnType<typeof vi.fn>).mockResolvedValue({
        title: "Small Blog",
        items,
      });

      const result = await service.subscribe("https://example.com");

      const sub = (result as { subscription: Subscription }).subscription;
      expect(sub.seenGuids).toHaveLength(0);
      expect(sub.title).toBe("Small Blog");
    });
  });

  describe("unsubscribe", () => {
    it("delegates to repo.delete", async () => {
      await service.unsubscribe("sub1");
      expect(repo.delete).toHaveBeenCalledWith("sub1");
    });
  });

  describe("listSubscriptions", () => {
    it("delegates to repo.list", async () => {
      const subs = [makeSub()];
      (repo.list as ReturnType<typeof vi.fn>).mockResolvedValue(subs);

      const result = await service.listSubscriptions();
      expect(result).toEqual(subs);
    });
  });

  describe("checkForNewPosts", () => {
    it("returns only unseen items", async () => {
      const sub = makeSub({ seenGuids: ["guid-0", "guid-1"] });
      const items = makeFeedItems(5);
      (feed.fetchAndParseFeed as ReturnType<typeof vi.fn>).mockResolvedValue({
        title: "Test Blog",
        items,
      });

      const newItems = await service.checkForNewPosts(sub);

      // guid-0 and guid-1 are seen, so only guid-2, guid-3, guid-4 are new
      expect(newItems).toHaveLength(3);
      expect(newItems.map((i) => i.guid)).toEqual([
        "guid-2",
        "guid-3",
        "guid-4",
      ]);
    });

    it("returns at most 5 items", async () => {
      const sub = makeSub();
      const items = makeFeedItems(10);
      (feed.fetchAndParseFeed as ReturnType<typeof vi.fn>).mockResolvedValue({
        title: "Test Blog",
        items,
      });

      const newItems = await service.checkForNewPosts(sub);
      expect(newItems.length).toBeLessThanOrEqual(5);
    });

    it("updates seenGuids and lastChecked on the subscription", async () => {
      const sub = makeSub({ seenGuids: ["old-guid"] });
      const items = makeFeedItems(2);
      (feed.fetchAndParseFeed as ReturnType<typeof vi.fn>).mockResolvedValue({
        title: "Test Blog",
        items,
      });

      await service.checkForNewPosts(sub);

      expect(repo.put).toHaveBeenCalled();
      const saved = (repo.put as ReturnType<typeof vi.fn>).mock.calls[0][0] as Subscription;
      expect(saved.lastChecked).toBeGreaterThan(0);
      expect(saved.seenGuids).toContain("guid-0");
      expect(saved.seenGuids).toContain("guid-1");
      expect(saved.seenGuids).toContain("old-guid");
    });

    it("returns empty array when all items are seen", async () => {
      const sub = makeSub({
        seenGuids: ["guid-0", "guid-1", "guid-2"],
      });
      const items = makeFeedItems(3);
      (feed.fetchAndParseFeed as ReturnType<typeof vi.fn>).mockResolvedValue({
        title: "Test Blog",
        items,
      });

      const newItems = await service.checkForNewPosts(sub);
      expect(newItems).toHaveLength(0);
    });
  });
});
