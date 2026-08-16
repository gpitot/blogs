import { describe, it, expect } from "vitest";
import { parseFeedXml } from "../../services/rss.ts";

function rssFeed(channelExtras: string, itemExtras: string): string {
  return `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"
     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Example Blog</title>
    ${channelExtras}
    <item>
      <title>A Post</title>
      <link>https://example.com/a-post</link>
      <pubDate>Tue, 05 Aug 2025 10:00:00 GMT</pubDate>
      ${itemExtras}
    </item>
  </channel>
</rss>`;
}

function atomFeed(feedExtras: string, entryExtras: string): string {
  return `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Blog</title>
  ${feedExtras}
  <entry>
    <title>A Post</title>
    <link href="https://example.com/a-post" rel="alternate"/>
    <updated>2025-08-05T10:00:00Z</updated>
    ${entryExtras}
  </entry>
</feed>`;
}

describe("parseFeedXml author extraction (RSS)", () => {
  it("reads dc:creator, the tag publishers actually use", () => {
    const feed = parseFeedXml(rssFeed("", "<dc:creator>Jane Doe</dc:creator>"));
    expect(feed.items[0]!.author).toBe("Jane Doe");
  });

  it("reads dc:creator wrapped in CDATA", () => {
    const feed = parseFeedXml(
      rssFeed("", "<dc:creator><![CDATA[Jane Doe]]></dc:creator>"),
    );
    expect(feed.items[0]!.author).toBe("Jane Doe");
  });

  it("joins repeated dc:creator into a co-authored byline", () => {
    const feed = parseFeedXml(
      rssFeed(
        "",
        "<dc:creator>AJ Gerstenhaber</dc:creator><dc:creator>Kenny Johnson</dc:creator>",
      ),
    );
    expect(feed.items[0]!.author).toBe("AJ Gerstenhaber, Kenny Johnson");
  });

  it("unwraps the name from an RSS <author> email", () => {
    const feed = parseFeedXml(
      rssFeed("", "<author>jane@example.com (Jane Doe)</author>"),
    );
    expect(feed.items[0]!.author).toBe("Jane Doe");
  });

  it("does not publish a bare email as the author", () => {
    const feed = parseFeedXml(rssFeed("", "<author>jane@example.com</author>"));
    expect(feed.items[0]!.author).toBe("");
  });

  it("prefers the item's own author over the channel's", () => {
    const feed = parseFeedXml(
      rssFeed(
        "<managingEditor>ed@example.com (Ed Editor)</managingEditor>",
        "<dc:creator>Jane Doe</dc:creator>",
      ),
    );
    expect(feed.items[0]!.author).toBe("Jane Doe");
  });

  it("falls back to the channel author when the item names none", () => {
    const feed = parseFeedXml(
      rssFeed("<itunes:author>House Author</itunes:author>", ""),
    );
    expect(feed.author).toBe("House Author");
    expect(feed.items[0]!.author).toBe("House Author");
  });

  it("reports no author when the feed carries none", () => {
    const feed = parseFeedXml(rssFeed("", ""));
    expect(feed.items[0]!.author).toBe("");
    expect(feed.author).toBe("");
  });

  it("does not mistake an item's author for the channel's", () => {
    const feed = parseFeedXml(rssFeed("", "<dc:creator>Jane Doe</dc:creator>"));
    expect(feed.author).toBe("");
  });
});

describe("parseFeedXml author extraction (Atom)", () => {
  it("reads the entry's <author><name>", () => {
    const feed = parseFeedXml(
      atomFeed("", "<author><name>Jane Doe</name></author>"),
    );
    expect(feed.items[0]!.author).toBe("Jane Doe");
  });

  it("falls back to the feed-level author, as simonwillison.net requires", () => {
    const feed = parseFeedXml(
      atomFeed("<author><name>Simon Willison</name></author>", ""),
    );
    expect(feed.author).toBe("Simon Willison");
    expect(feed.items[0]!.author).toBe("Simon Willison");
  });

  it("joins multiple entry authors", () => {
    const feed = parseFeedXml(
      atomFeed(
        "",
        "<author><name>Jane Doe</name></author><author><name>John Roe</name></author>",
      ),
    );
    expect(feed.items[0]!.author).toBe("Jane Doe, John Roe");
  });

  it("ignores an author element carrying only a URI", () => {
    const feed = parseFeedXml(
      atomFeed("", "<author><uri>https://example.com/jane</uri></author>"),
    );
    expect(feed.items[0]!.author).toBe("");
  });
});
