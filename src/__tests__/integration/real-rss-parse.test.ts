import { describe, it, expect } from "vitest";
import { fetchAndParseFeed } from "../../services/rss.ts";

const FEED_URL = "https://brennan.day/feed.xml";

describe("Real RSS feed parsing: brennan.day", () => {
  it(
    "parses feed and uses only content:encoded",
    { timeout: 30_000 },
    async () => {
      const feed = await fetchAndParseFeed(FEED_URL);

      expect(feed.title).toBeTruthy();
      expect(feed.items.length).toBeGreaterThan(0);

      for (const item of feed.items.slice(0, 1)) {
        expect(item.guid).toBeTruthy();
        expect(item.title).toBeTruthy();
        expect(item.link).toMatch(/^https?:\/\//);
        expect(item.pubDate).toBeGreaterThan(0);

        // content should only come from content:encoded, never description
        // If the feed item has content, it must be substantial HTML
        if (item.content) {
          expect(item.content.length).toBeGreaterThan(100);
          expect(item.content).toContain("<");
        }
      }
    },
  );
});
