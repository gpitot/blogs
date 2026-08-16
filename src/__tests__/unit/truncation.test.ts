import { describe, it, expect } from "vitest";
import { classifyCompleteness, detectRawPaywall, textLength } from "../../services/truncation.ts";

const MARS_URL = "https://mceglowski.substack.com/p/a-diners-guide-to-mars";

const BODY = `
  <p>NASA&#x2019;s first brush with malnutrition came during the Apollo 15 mission in 1973.</p>
  <p>Analysis after the mission concluded that dehydration had set in during training.</p>
`;

describe("classifyCompleteness", () => {
  describe("truncation", () => {
    // Verbatim tail from 2026-W27 ch1 in the sample epubs.
    it("flags the Substack 'Read more' tail", () => {
      const html = `${BODY}
        <p>
            <a href="${MARS_URL}">
                Read more
            </a>
        </p>`;

      const result = classifyCompleteness(html, MARS_URL);

      expect(result.kind).toBe("truncated");
      expect(result).toHaveProperty("evidence", "Read more");
    });

    it("flags a WordPress 'Continue reading' tail", () => {
      const html = `${BODY}
        <p><a href="https://example.com/other">Continue reading <span>My Post</span> &#x2192;</a></p>`;

      expect(classifyCompleteness(html, "https://example.com/post").kind).toBe("truncated");
    });

    it("flags a bare self-link tail even when the wording is unfamiliar", () => {
      const html = `${BODY}<p><a href="${MARS_URL}?utm_source=rss">Voir la suite</a></p>`;

      const result = classifyCompleteness(html, MARS_URL);

      expect(result.kind).toBe("truncated");
      expect(result).toHaveProperty("evidence", "self-link: Voir la suite");
    });

    it("ignores trailing empty elements when locating the tail", () => {
      const html = `${BODY}
        <p><a href="${MARS_URL}">Read more</a></p>
        <hr/>
        <div></div>`;

      expect(classifyCompleteness(html, MARS_URL).kind).toBe("truncated");
    });

    it("matches a self-link regardless of trailing slash", () => {
      const html = `${BODY}<p><a href="https://example.com/post/">Full story</a></p>`;

      expect(classifyCompleteness(html, "https://example.com/post").kind).toBe("truncated");
    });
  });

  describe("paywalls", () => {
    it.each([
      "This post is for paid subscribers",
      "This post is for paying subscribers",
      "Subscribe to continue reading",
      "Upgrade to paid to read the rest",
      "This article is for members only",
    ])("flags %j", (phrase) => {
      const result = classifyCompleteness(`${BODY}<p>${phrase}</p>`, MARS_URL);

      expect(result.kind).toBe("paywalled");
    });

    it("reports paywalled rather than truncated when both markers are present", () => {
      const html = `${BODY}
        <p>This post is for paid subscribers</p>
        <p><a href="${MARS_URL}">Read more</a></p>`;

      expect(classifyCompleteness(html, MARS_URL).kind).toBe("paywalled");
    });

    it("does not fire on paywall wording buried early in a long article", () => {
      const html = `<p>Subscribe to continue reading, they said.</p>${"<p>".concat(
        "Real article prose that goes on at length. ".repeat(40),
        "</p>",
      )}`;

      expect(classifyCompleteness(html, MARS_URL).kind).toBe("complete");
    });
  });

  describe("complete articles", () => {
    it("accepts a footnote backlink as the final block", () => {
      // Verbatim tail of dynomight.net/betteridge — a complete article whose
      // last block is a lone ↩ link back to the footnote reference.
      const url = "https://dynomight.net/betteridge/";
      const html = `${BODY}
        <div><ol>
          <li><p>Implicitly, this applies only to yes/no questions.&#xa0;<a href="https://dynomight.net/betteridge/#fnref:1">&#x21a9;</a></p></li>
          <li><p>Hi Twitter.&#xa0;<a href="https://dynomight.net/betteridge/#fnref:2">&#x21a9;</a></p></li>
        </ol></div>`;

      expect(classifyCompleteness(html, url).kind).toBe("complete");
    });

    it("accepts a relative in-page anchor as the final block", () => {
      const html = `${BODY}<p>Note.<a href="#fnref:1">&#x21a9;</a></p>`;

      expect(classifyCompleteness(html, "https://example.com/post").kind).toBe("complete");
    });

    it("accepts a body ending in a footnote list full of outbound links", () => {
      // Shape of 2026-W26 ch1 (L'Affaire Siloxane), which came through in full.
      const html = `${BODY}
        <div><a href="${MARS_URL}#footnote-anchor-1">1</a><div><p>Look for dimethicone in the ingredient list.</p></div></div>
        <div><a href="${MARS_URL}#footnote-anchor-2">2</a><div><p>I mean this in the computer science sense.</p></div></div>`;

      expect(classifyCompleteness(html, MARS_URL).kind).toBe("complete");
    });

    it("accepts the 'appeared first on' RSS footer", () => {
      const html = `${BODY}
        <p>The post <a href="https://www.scotthyoung.com/blog/2026/06/19/how-habits-actually-work/">How Habits Actually Work</a> appeared first on <a href="https://www.scotthyoung.com">Scott H Young</a>.</p>`;

      expect(
        classifyCompleteness(html, "https://www.scotthyoung.com/blog/2026/06/19/how-habits-actually-work/").kind,
      ).toBe("complete");
    });

    it("accepts a closing sentence that happens to contain a link", () => {
      const html = `${BODY}
        <p>You might as well be relying on <a href="https://en.wikipedia.org/wiki/Sleep-learning">hypnopedia</a>, which is the whole point of this piece.</p>`;

      expect(classifyCompleteness(html, "https://idiallo.com/blog/kung-fu").kind).toBe("complete");
    });

    it("accepts an in-body 'read more about' link that is not at the tail", () => {
      const html = `<p><a href="https://example.com/elsewhere">Read more about this</a></p>${BODY}`;

      expect(classifyCompleteness(html, "https://example.com/post").kind).toBe("complete");
    });

    it("accepts a plain body with no links at all", () => {
      expect(classifyCompleteness(BODY, MARS_URL).kind).toBe("complete");
    });

    it("treats empty content as complete, leaving that check to the caller", () => {
      expect(classifyCompleteness("", MARS_URL).kind).toBe("complete");
      expect(classifyCompleteness("   ", MARS_URL).kind).toBe("complete");
    });

    it("does not crash on an unparseable article URL", () => {
      const html = `${BODY}<p><a href="not a url">Onwards</a></p>`;

      expect(classifyCompleteness(html, "also not a url").kind).toBe("complete");
    });
  });
});

describe("detectRawPaywall", () => {
  it("catches the Substack wall as it appears on the live page", () => {
    // Verbatim from mceglowski.substack.com/p/a-diners-guide-to-mars.
    const html = `<p>So why not take some with us?</p></div></div></div>
      <div data-testid="paywall" data-component-name="Paywall" role="region" aria-label="Paywall" class="paywall">
      <h2 class="paywall-title unlock-treatment-new">Continue reading this post for free, courtesy of Maciej Cegłowski.</h2>
      <button class="pencraft subscribe-btn paywall-cta-icon">Claim my free post</button></div>`;

    expect(detectRawPaywall(html)).toBeTruthy();
  });

  it("catches a Ghost members-only upgrade CTA", () => {
    expect(detectRawPaywall('<div class="gh-post-upgrade-cta">Subscribe</div>')).toBeTruthy();
  });

  it("ignores Substack's inline JSON config keys", () => {
    // These appear on every Substack page, paywalled or not. An underscore is a
    // word character, so \bpaywall\b must not match them.
    const html = `<script>window._preloads = {"expose_paywall_content_to_search_engines":true,
      "paywall_free_trial_enabled":true,"paywall_chat":"paid"}</script>
      <article><p>A completely free post.</p></article>`;

    expect(detectRawPaywall(html)).toBeNull();
  });

  it("ignores an article that merely writes about paywalls", () => {
    const html = `<article><h1>Why paywalls are bad</h1>
      <p>The paywall is a blight. Every paywall I meet, I resent.</p>
      <p>Some sites use a paywall; others do not.</p></article>`;

    expect(detectRawPaywall(html)).toBeNull();
  });

  it("returns null for an ordinary open page", () => {
    expect(detectRawPaywall("<article><p>Just an article.</p></article>")).toBeNull();
  });
});

describe("textLength", () => {
  it("measures visible text, not markup", () => {
    expect(textLength("<p>hello <strong>world</strong></p>")).toBe("hello world".length);
  });

  it("collapses whitespace so formatting does not inflate the count", () => {
    expect(textLength("<p>hello\n\n     world</p>")).toBe("hello world".length);
  });

  it("returns 0 for empty content", () => {
    expect(textLength("")).toBe(0);
  });
});
