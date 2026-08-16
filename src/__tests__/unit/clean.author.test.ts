import { describe, it, expect } from "vitest";
import {
  extractArticle,
  extractArticleFromFeedContent,
} from "../../services/clean.ts";

const URL = "https://example.com/post";

const BODY = `
  <article>
    <h1>A Post</h1>
    <p>${"This is the body of the article, long enough that Readability keeps it. ".repeat(8)}</p>
    <p>${"A second paragraph adds the substance Readability looks for in content. ".repeat(6)}</p>
  </article>`;

function page(head: string, body = BODY): string {
  return `<!DOCTYPE html><html><head><title>A Post</title>${head}</head><body>${body}</body></html>`;
}

describe("extractArticle author recovery", () => {
  it("reads meta[name=author], which Readability ignores", () => {
    const article = extractArticle(
      page(`<meta name="author" content="Jane Doe">`),
      URL,
    );
    expect(article.byline).toBe("Jane Doe");
  });

  it("reads JSON-LD author.name", () => {
    const ld = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      author: { "@type": "Person", name: "Ann Lee" },
    });
    const article = extractArticle(
      page(`<script type="application/ld+json">${ld}</script>`),
      URL,
    );
    expect(article.byline).toBe("Ann Lee");
  });

  it("reads JSON-LD authors nested under @graph", () => {
    const ld = JSON.stringify({
      "@graph": [{ "@type": "WebSite" }, { author: ["Ann Lee", "Bo Chen"] }],
    });
    const article = extractArticle(
      page(`<script type="application/ld+json">${ld}</script>`),
      URL,
    );
    expect(article.byline).toBe("Ann Lee, Bo Chen");
  });

  it("survives a malformed JSON-LD block", () => {
    const article = extractArticle(
      page(
        `<meta name="author" content="Jane Doe"><script type="application/ld+json">{not json</script>`,
      ),
      URL,
    );
    expect(article.byline).toBe("Jane Doe");
  });

  it("reads itemprop=author, preferring the nested name", () => {
    const article = extractArticle(
      page(
        "",
        `<div itemprop="author"><span itemprop="name">Carl Ray</span><span>Senior Staff Writer</span></div>${BODY}`,
      ),
      URL,
    );
    expect(article.byline).toBe("Carl Ray");
  });

  it("ignores a profile URL in article:author", () => {
    const article = extractArticle(
      page(`<meta property="article:author" content="https://facebook.com/jane">`),
      URL,
    );
    expect(article.byline).toBe("");
  });

  it("accepts a twitter:creator handle only as a last resort", () => {
    const article = extractArticle(
      page(
        `<meta name="twitter:creator" content="@janedoe"><meta name="author" content="Jane Doe">`,
      ),
      URL,
    );
    expect(article.byline).toBe("Jane Doe");
  });

  it("exposes siteName so callers can credit the publication", () => {
    const article = extractArticle(
      page(`<meta property="og:site_name" content="Cloudflare Blog">`),
      URL,
    );
    expect(article.byline).toBe("");
    expect(article.siteName).toBe("Cloudflare Blog");
  });
});

describe("extractArticleFromFeedContent", () => {
  const content = `<p>${"Feed body content that is plenty long. ".repeat(20)}</p>`;

  it("carries the byline supplied by the feed", () => {
    const article = extractArticleFromFeedContent(
      content,
      "A Post",
      URL,
      "Jane Doe",
    );
    expect(article.byline).toBe("Jane Doe");
  });

  it("stays empty when the feed named no author", () => {
    expect(extractArticleFromFeedContent(content, "A Post", URL).byline).toBe("");
  });
});
