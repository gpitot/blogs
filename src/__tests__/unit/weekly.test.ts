import { describe, it, expect } from "vitest";
import { selectUnsentArticles } from "../../weekly.ts";
import { MAX_ARTICLES_PER_FEED, isAutoSendWeeklyEnabled } from "../../repositories/types.ts";
import type { ConvertedArticle } from "../../repositories/types.ts";

/** Builds a newest-first convertedArticles list, as the feed repo stores it. */
function converted(...ids: string[]): ConvertedArticle[] {
  return ids.map((id, i) => ({
    cacheKey: `epub:${id}`,
    articleId: id,
    title: `Article ${id}`,
    createdAt: 1000 - i,
  }));
}

function ids(entries: ConvertedArticle[]): string[] {
  return entries.map((e) => e.articleId);
}

describe("selectUnsentArticles", () => {
  it("returns every unsent article, not just the newest one", () => {
    const { selected, deferred } = selectUnsentArticles(converted("c", "b", "a"), new Set());

    expect(ids(selected)).toEqual(["a", "b", "c"]);
    expect(deferred).toBe(0);
  });

  it("skips articles the user has already been sent", () => {
    const { selected } = selectUnsentArticles(converted("c", "b", "a"), new Set(["a", "b"]));

    expect(ids(selected)).toEqual(["c"]);
  });

  it("returns nothing when the feed published no new articles", () => {
    const { selected, deferred } = selectUnsentArticles(
      converted("c", "b", "a"),
      new Set(["a", "b", "c"]),
    );

    expect(selected).toEqual([]);
    expect(deferred).toBe(0);
  });

  it("caps a single feed and defers the rest to a later week", () => {
    const all = Array.from({ length: MAX_ARTICLES_PER_FEED + 3 }, (_, i) => `a${i}`);
    const { selected, deferred } = selectUnsentArticles(converted(...all), new Set());

    expect(selected).toHaveLength(MAX_ARTICLES_PER_FEED);
    expect(deferred).toBe(3);
    // Keeps the newest MAX_ARTICLES_PER_FEED, oldest-first within the book.
    expect(ids(selected)).toEqual(all.slice(0, MAX_ARTICLES_PER_FEED).reverse());
  });

  it("orders selected articles oldest-first for reading", () => {
    const { selected } = selectUnsentArticles(converted("newest", "middle", "oldest"), new Set());

    expect(ids(selected)).toEqual(["oldest", "middle", "newest"]);
  });

  it("handles a feed that has never converted anything", () => {
    expect(selectUnsentArticles(undefined, new Set())).toEqual({ selected: [], deferred: 0 });
    expect(selectUnsentArticles([], new Set())).toEqual({ selected: [], deferred: 0 });
  });
});

describe("isAutoSendWeeklyEnabled", () => {
  it("keeps sending for users who predate the setting", () => {
    expect(isAutoSendWeeklyEnabled({})).toBe(true);
    expect(isAutoSendWeeklyEnabled({ autoSendWeekly: undefined })).toBe(true);
  });

  it("sends only when the user has not opted out", () => {
    expect(isAutoSendWeeklyEnabled({ autoSendWeekly: true })).toBe(true);
    expect(isAutoSendWeeklyEnabled({ autoSendWeekly: false })).toBe(false);
  });
});
