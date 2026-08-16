import { describe, it, expect } from "vitest";
import { detectChallenge, looksLikeFeedBody } from "../../http/challenge.ts";

// The exact stub neglectedbooks.com returns to our proxy's egress IPs.
const SITEGROUND_STUB =
  '<html><head><link rel="icon" href="data:;"><meta http-equiv="refresh" ' +
  'content="0;/.well-known/sgcaptcha/?r=%2F&y=ipr:2a06:98c0:3600::103:1786858597.307"></meta></head></html>';

describe("detectChallenge", () => {
  it("flags the SiteGround 202 interstitial", () => {
    expect(detectChallenge(202, "text/html", SITEGROUND_STUB)).toContain("SiteGround");
  });

  it("flags a tiny meta-refresh stub even without a known vendor marker", () => {
    const stub = '<html><head><meta http-equiv="refresh" content="0;/wait"></head></html>';
    expect(detectChallenge(200, "text/html", stub)).toContain("meta-refresh");
  });

  it("flags a Cloudflare interstitial served with a 200", () => {
    const body = "<html><head><title>Just a moment...</title></head><body></body></html>";
    expect(detectChallenge(200, "text/html", body)).toContain("Cloudflare");
  });

  it("flags outright blocks by status", () => {
    expect(detectChallenge(403, "text/html", "nope")).toContain("403");
    expect(detectChallenge(429, "text/html", "slow down")).toContain("429");
  });

  it("passes a real feed through", () => {
    const feed = '<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title></channel></rss>';
    expect(detectChallenge(200, "application/rss+xml", feed)).toBeNull();
  });

  it("does not flag a page that merely mentions captchas", () => {
    const post = `<html><body>${"<p>Why captcha puzzles are annoying.</p>".repeat(50)}</body></html>`;
    expect(detectChallenge(200, "text/html", post)).toBeNull();
  });

  it("works without a body, for HEAD-style probes", () => {
    expect(detectChallenge(202, "text/html")).toContain("202");
    expect(detectChallenge(200, "application/rss+xml")).toBeNull();
  });
});

describe("looksLikeFeedBody", () => {
  it("accepts RSS", () => {
    expect(looksLikeFeedBody('<?xml version="1.0"?><rss version="2.0"><channel/></rss>')).toBe(true);
  });

  it("accepts Atom", () => {
    expect(looksLikeFeedBody('<feed xmlns="http://www.w3.org/2005/Atom"><title>x</title></feed>')).toBe(
      true,
    );
  });

  it("accepts RDF/RSS 1.0", () => {
    expect(looksLikeFeedBody('<rdf:RDF xmlns="http://purl.org/rss/1.0/"></rdf:RDF>')).toBe(true);
  });

  it("rejects a challenge stub", () => {
    expect(looksLikeFeedBody(SITEGROUND_STUB)).toBe(false);
  });

  it("rejects an ordinary HTML page", () => {
    expect(looksLikeFeedBody("<!doctype html><html><body><h1>Hello</h1></body></html>")).toBe(false);
  });
});
