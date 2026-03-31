import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryKV } from "../helpers/memory-kv.ts";
import { KvSubscriptionRepo } from "../../repositories/kv.ts";
import { BlogsService } from "../../services/blogs.service.ts";
import type { FeedClient } from "../../services/interfaces.ts";
import type { FeedItem } from "../../services/rss.ts";

function makeFeedItems(count: number): FeedItem[] {
  return Array.from({ length: count }, (_, i) => ({
    guid: `guid-${i}`,
    title: `Post ${i}`,
    link: `https://example.com/post-${i}`,
    pubDate: Date.now() - i * 86400000,
    content: `<p>Content for post ${i}</p>`,
  }));
}

describe("Subscribe flow (integration)", () => {
  let service: BlogsService;
  let feedClient: FeedClient;

  beforeEach(() => {
    feedClient = {
      detectFeedUrl: vi.fn().mockResolvedValue("https://example.com/feed"),
      fetchAndParseFeed: vi.fn().mockResolvedValue({
        title: "Test Blog",
        items: makeFeedItems(10),
      }),
    };
    const kv = new MemoryKV() as unknown as KVNamespace;
    const repo = new KvSubscriptionRepo(kv);
    service = new BlogsService(repo, feedClient);
  });

  it("full lifecycle: subscribe → list → check new posts → unsubscribe", async () => {
    // Subscribe
    const result = await service.subscribe("https://example.com");
    expect(result).toHaveProperty("subscription");
    const sub = (result as { subscription: any }).subscription;
    expect(sub.title).toBe("Test Blog");
    expect(sub.feedUrl).toBe("https://example.com/feed");

    // List should include the new subscription
    const subs = await service.listSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0].id).toBe(sub.id);

    // Check for new posts (items not in seenGuids)
    const newItems = await service.checkForNewPosts(sub);
    expect(newItems.length).toBeLessThanOrEqual(5);

    // Verify subscription was updated with new seenGuids
    const updatedSubs = await service.listSubscriptions();
    expect(updatedSubs[0].lastChecked).toBeGreaterThan(0);
    expect(updatedSubs[0].seenGuids.length).toBeGreaterThan(0);

    // Unsubscribe
    await service.unsubscribe(sub.id);
    const remaining = await service.listSubscriptions();
    expect(remaining).toHaveLength(0);
  });

  it("multiple subscriptions are independent", async () => {
    // First subscription
    await service.subscribe("https://blog-a.com");

    // Second subscription with different feed
    (feedClient.detectFeedUrl as ReturnType<typeof vi.fn>).mockResolvedValue(
      "https://blog-b.com/feed",
    );
    (feedClient.fetchAndParseFeed as ReturnType<typeof vi.fn>).mockResolvedValue({
      title: "Blog B",
      items: makeFeedItems(3),
    });
    await service.subscribe("https://blog-b.com");

    const subs = await service.listSubscriptions();
    expect(subs).toHaveLength(2);
    expect(subs.map((s) => s.title).sort()).toEqual(["Blog B", "Test Blog"]);

    // Delete first, second should remain
    await service.unsubscribe(subs[0].id);
    const remaining = await service.listSubscriptions();
    expect(remaining).toHaveLength(1);
  });
});
