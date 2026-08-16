/**
 * Bot-protection detection.
 *
 * WAFs and anti-bot layers rarely return a clean 403. They serve a 200/202 HTML
 * interstitial that a naive parser reads as "a page with no feed in it", which
 * turns a temporary IP block into a permanently wrong error message (and, for
 * feeds, into a silently empty subscription). These helpers spot the common
 * interstitials so callers can report "blocked" instead of "not found".
 */

/**
 * Strings unique to known interstitials. Kept specific on purpose — a generic
 * word like "captcha" appears in plenty of legitimate blog posts.
 */
const CHALLENGE_MARKERS: Array<[marker: string, vendor: string]> = [
  ["/.well-known/sgcaptcha", "SiteGround"],
  ["robot challenge screen", "SiteGround"],
  ["/cdn-cgi/challenge-platform", "Cloudflare"],
  ["<title>just a moment", "Cloudflare"],
  ["checking your browser before accessing", "Cloudflare"],
  ["attention required! | cloudflare", "Cloudflare"],
  ["enable javascript and cookies to continue", "Cloudflare"],
  ["_incapsula_resource", "Imperva"],
  ["incapsula incident id", "Imperva"],
  ["ddos-guard", "DDoS-Guard"],
  ["px-captcha", "PerimeterX"],
  ["/_sec/cp_challenge/", "Akamai"],
];

/** HTML bodies below this are too small to be a real page. */
const INTERSTITIAL_MAX_BYTES = 2048;

function isHtmlish(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return ct === "" || ct.includes("html") || ct.includes("text/plain");
}

/**
 * Returns a human-readable reason when the response looks like a bot challenge
 * or an outright block, or null when it looks like a genuine response.
 *
 * `body` is optional so HEAD probes can use the status-only rules.
 */
export function detectChallenge(
  status: number,
  contentType: string,
  body?: string,
): string | null {
  const htmlish = isHtmlish(contentType);

  if (body) {
    // Markers win over status: challenges are frequently served with a 200.
    const head = body.slice(0, 8192).toLowerCase();
    for (const [marker, vendor] of CHALLENGE_MARKERS) {
      if (head.includes(marker)) return `${vendor} bot challenge`;
    }

    // SiteGround's stub is a bare meta-refresh to its challenge path. Any tiny
    // HTML document whose only job is to redirect is the same shape.
    if (
      htmlish &&
      body.length < INTERSTITIAL_MAX_BYTES &&
      /<meta[^>]+http-equiv=["']?refresh/i.test(body)
    ) {
      return "bot challenge (meta-refresh interstitial)";
    }
  }

  // 202 for a document request is not a thing real sites do; it is how
  // SiteGround hands back its challenge stub.
  if (status === 202 && htmlish) return "bot challenge (HTTP 202)";
  if (status === 403 || status === 429 || status === 503) {
    return `blocked by the site (HTTP ${status})`;
  }

  return null;
}

/**
 * True when the body starts out as an RSS/Atom/RDF document. Sniffing beats
 * trusting content-type, which plenty of hosts get wrong for feeds.
 */
export function looksLikeFeedBody(body: string): boolean {
  const head = body.slice(0, 2048);
  return (
    /<rss[\s>]/i.test(head) ||
    /<rdf:RDF[\s>]/i.test(head) ||
    /<channel[\s>]/i.test(head) ||
    // Require the namespace so an HTML page mentioning <feed> can't match.
    /<feed[\s][^>]*xmlns/i.test(head)
  );
}
