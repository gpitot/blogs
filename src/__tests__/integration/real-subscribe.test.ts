import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";

const BASE_URL = "http://localhost:8787";
const BLOG_URLS = [
  "https://cacm.acm.org/section/news/",
  "https://brennan.day/feed.xml",
];

/** Extract unique subscription IDs from the subscriptions page HTML. */
function extractSubIds(html: string): string[] {
  const matches = [...html.matchAll(/\/subscriptions\/([a-f0-9]+)\/delete/g)];
  return [...new Set(matches.map((m) => m[1]!))];
}

/** Remove all existing subscriptions so we start clean. */
async function removeAllSubscriptions(): Promise<void> {
  const resp = await fetch(`${BASE_URL}/subscriptions`);
  const html = await resp.text();
  for (const id of extractSubIds(html)) {
    await fetch(`${BASE_URL}/subscriptions/${id}/delete`, {
      method: "POST",
      redirect: "manual",
    });
  }
}

describe("Real subscription + cron job via dev API", () => {
  it("subscribe → trigger cron → verify articles & weekly book → cleanup", { timeout: 120_000 }, async () => {
    // 0. Clean slate
    await removeAllSubscriptions();

    // 1. Subscribe to both blogs
    for (const url of BLOG_URLS) {
      const form = new FormData();
      form.set("url", url);
      const resp = await fetch(`${BASE_URL}/subscriptions`, {
        method: "POST",
        body: form,
      });
      expect(resp.status).toBe(200);
      const html = await resp.text();
      expect(html).toContain("Subscribed to");
    }

    // 2. List subscriptions and extract IDs
    const listResp = await fetch(`${BASE_URL}/subscriptions`);
    const listHtml = await listResp.text();
    const subIds = extractSubIds(listHtml);
    expect(subIds.length).toBe(2);

    // 3. Trigger cron job
    const cronResp = await fetch(`${BASE_URL}/__scheduled`);
    expect(cronResp.ok).toBe(true);

    // 4. Poll until articles appear on the subscriptions page (cron runs via waitUntil)
    let articleCount = 0;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const resp = await fetch(`${BASE_URL}/subscriptions`);
      const html = await resp.text();
      articleCount = [...html.matchAll(/download\/article\/[a-f0-9]+/g)].length;
      if (articleCount > 0) break;
    }
    expect(articleCount).toBeGreaterThan(0);

    // 5. Verify weekly book was generated
    const booksResp = await fetch(`${BASE_URL}/weekly-books`);
    const booksHtml = await booksResp.text();
    const weeklyMatch = booksHtml.match(/download\/weekly\/(\d{4}-W\d{2})/);
    expect(weeklyMatch).toBeTruthy();

    // 6. Download weekly book and validate EPUB
    const weekKey = weeklyMatch![1]!;
    const downloadResp = await fetch(`${BASE_URL}/download/weekly/${weekKey}`);
    expect(downloadResp.ok).toBe(true);
    expect(downloadResp.headers.get("content-type")).toBe("application/epub+zip");

    const buf = await downloadResp.arrayBuffer();
    const epub = new Uint8Array(buf);
    expect(epub.byteLength).toBeGreaterThan(1000);
    expect(epub[0]).toBe(0x50);
    expect(epub[1]).toBe(0x4b);

    const files = unzipSync(epub);
    const filenames = Object.keys(files);
    expect(filenames).toContain("mimetype");
    expect(filenames).toContain("OEBPS/content.opf");
    expect(filenames).toContain("OEBPS/ch1.xhtml");

    const mimetype = strFromU8(files["mimetype"]!);
    expect(mimetype).toBe("application/epub+zip");

    // 7. Cleanup: unsubscribe from both
    await removeAllSubscriptions();
    const finalResp = await fetch(`${BASE_URL}/subscriptions`);
    const finalHtml = await finalResp.text();
    expect(finalHtml).toContain("No subscriptions yet");
  });
});
