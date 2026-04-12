import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";

const BASE_URL = "http://localhost:8787";
const BLOG_URL = "https://cacm.acm.org/news/how-nasa-built-artemis-iis-fault-tolerant-computer/";

describe("Real blog post conversion via dev API", () => {
  it("POST /convert → follow redirect → GET /download/:key returns valid EPUB", { timeout: 60_000 }, async () => {
    // 1. POST /convert with real blog URL (don't follow redirect automatically)
    const form = new FormData();
    form.set("url", BLOG_URL);
    const convertResp = await fetch(`${BASE_URL}/convert`, {
      method: "POST",
      body: form,
      redirect: "manual",
    });
    console.log(convertResp)
    expect(convertResp.status).toBe(303);
    const location = convertResp.headers.get("location");
    expect(location).toBeTruthy();
    expect(location).toMatch(/^\/download\/[a-f0-9]+$/);

    // 2. GET the EPUB from the download URL
    const downloadResp = await fetch(`${BASE_URL}${location}`);
    expect(downloadResp.ok).toBe(true);
    expect(downloadResp.headers.get("content-type")).toBe(
      "application/epub+zip",
    );
    const disposition = downloadResp.headers.get("content-disposition");
    expect(disposition).toMatch(/\.epub"/);

    // 3. Validate EPUB binary
    const buf = await downloadResp.arrayBuffer();
    const epub = new Uint8Array(buf);
    expect(epub.byteLength).toBeGreaterThan(1000);
    expect(epub[0]).toBe(0x50);
    expect(epub[1]).toBe(0x4b);

    // 4. Validate EPUB structure
    const files = unzipSync(epub);
    const filenames = Object.keys(files);
    expect(filenames).toContain("mimetype");
    expect(filenames).toContain("META-INF/container.xml");
    expect(filenames).toContain("OEBPS/content.opf");
    expect(filenames).toContain("OEBPS/nav.xhtml");
    expect(filenames).toContain("OEBPS/cover.xhtml");
    expect(filenames).toContain("OEBPS/ch1.xhtml");

    const mimetype = strFromU8(files["mimetype"]!);
    expect(mimetype).toBe("application/epub+zip");

    const chapter = strFromU8(files["OEBPS/ch1.xhtml"]!);
    expect(chapter.length).toBeGreaterThan(500);
  });
});
