import type { Subscription } from "./storage.ts";

// ---------------------------------------------------------------------------
// Shared styles / layout helpers
// ---------------------------------------------------------------------------

const baseStyles = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    max-width: 640px;
    margin: 5rem auto;
    padding: 0 1.25rem;
    color: #1a1a1a;
    background: #fafafa;
  }
  h1 { font-size: 1.75rem; margin-bottom: .25rem; }
  h2 { font-size: 1.25rem; margin: 1.75rem 0 .75rem; }
  p.subtitle { color: #555; margin-top: 0; margin-bottom: 1.5rem; }
  label { display: block; font-weight: 500; margin-bottom: .35rem; }
  input[type=url], input[type=text] {
    width: 100%;
    padding: .55rem .75rem;
    font-size: 1rem;
    border: 1px solid #ccc;
    border-radius: 6px;
    background: #fff;
  }
  input[type=url]:focus, input[type=text]:focus {
    outline: 2px solid #0070f3;
    border-color: transparent;
  }
  button {
    margin-top: .75rem;
    padding: .55rem 1.4rem;
    font-size: 1rem;
    font-weight: 600;
    color: #fff;
    background: #0070f3;
    border: none;
    border-radius: 6px;
    cursor: pointer;
  }
  button:hover { background: #005bcc; }
  button.danger {
    background: #cf1322;
    margin-top: 0;
    padding: .3rem .8rem;
    font-size: .85rem;
  }
  button.danger:hover { background: #a8071a; }
  .error {
    margin-top: 1rem;
    padding: .65rem .9rem;
    background: #fff1f0;
    border: 1px solid #ffa39e;
    border-radius: 6px;
    color: #a8071a;
  }
  .success {
    margin-top: 1rem;
    padding: .65rem .9rem;
    background: #f6ffed;
    border: 1px solid #b7eb8f;
    border-radius: 6px;
  }
  .success a { color: #237804; font-weight: 600; text-decoration: none; }
  .success a:hover { text-decoration: underline; }
  nav { margin-bottom: 2rem; font-size: .9rem; }
  nav a { color: #0070f3; text-decoration: none; margin-right: 1rem; }
  nav a:hover { text-decoration: underline; }
  nav a.active { font-weight: 600; color: #1a1a1a; }
  footer { margin-top: 3rem; font-size: .8rem; color: #aaa; }
  .sub-list { list-style: none; padding: 0; margin: 0; }
  .sub-item {
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    padding: .85rem 1rem;
    margin-bottom: .75rem;
    background: #fff;
  }
  .sub-item-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: .5rem;
  }
  .sub-title { font-weight: 600; font-size: 1rem; margin: 0 0 .2rem; }
  .sub-meta { font-size: .8rem; color: #666; }
  .sub-epubs { margin-top: .6rem; padding-left: 0; list-style: none; }
  .sub-epubs li { font-size: .85rem; margin-bottom: .2rem; }
  .sub-epubs a { color: #0070f3; text-decoration: none; }
  .sub-epubs a:hover { text-decoration: underline; }
  .empty { color: #888; font-style: italic; font-size: .9rem; }
`;

function page(title: string, nav: string, body: string): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(title)}</title>
  <style>${baseStyles}</style>
</head>
<body>
  <nav>${nav}</nav>
  ${body}
  <footer>Powered by Cloudflare Workers</footer>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

const NAV_CONVERT = `<a href="/">Convert</a><a href="/subscriptions" class="active">Subscriptions</a>`;
const NAV_SUBS = `<a href="/" >Convert</a><a href="/subscriptions" class="active">Subscriptions</a>`;

// ---------------------------------------------------------------------------
// Convert page
// ---------------------------------------------------------------------------

interface UIOptions {
  error?: string;
  downloadUrl?: string;
  downloadTitle?: string;
}

export function renderUI(options: UIOptions = {}): Response {
  const nav = `<a href="/" class="active">Convert</a><a href="/subscriptions">Subscriptions</a>`;
  const body = `
  <h1>Blog to EPUB</h1>
  <p class="subtitle">Paste a blog post URL and download it as an EPUB for your e-reader.</p>

  <form method="POST" action="/convert">
    <label for="url">Blog post URL</label>
    <input
      type="url"
      id="url"
      name="url"
      placeholder="https://example.com/post/article-title"
      required
      autocomplete="off"
    />
    <br/>
    <button type="submit">Convert to EPUB</button>
  </form>

  ${options.error ? `<div class="error">${escapeHtml(options.error)}</div>` : ""}
  ${options.downloadUrl
    ? `<div class="success">
        Your EPUB is ready: <a href="${escapeHtml(options.downloadUrl)}" download>
          ${escapeHtml(options.downloadTitle || "Download EPUB")}
        </a>
      </div>`
    : ""}`;

  return page("Blog to EPUB", nav, body);
}

// ---------------------------------------------------------------------------
// Subscriptions page
// ---------------------------------------------------------------------------

interface SubscriptionsOptions {
  error?: string;
  success?: string;
}

export function renderSubscriptionsUI(
  subs: Subscription[],
  options: SubscriptionsOptions = {},
): Response {
  const nav = `<a href="/">Convert</a><a href="/subscriptions" class="active">Subscriptions</a>`;

  const subItems = subs.length === 0
    ? `<p class="empty">No subscriptions yet. Add a blog below to get started.</p>`
    : `<ul class="sub-list">${subs.map(renderSubItem).join("")}</ul>`;

  const body = `
  <h1>Blog Subscriptions</h1>
  <p class="subtitle">Subscribe to a blog's RSS feed and new posts will be automatically converted to EPUB.</p>

  <form method="POST" action="/subscriptions">
    <label for="url">Blog or feed URL</label>
    <input
      type="url"
      id="url"
      name="url"
      placeholder="https://example.com or https://example.com/feed"
      required
      autocomplete="off"
    />
    <br/>
    <button type="submit">Subscribe</button>
  </form>

  ${options.error ? `<div class="error">${escapeHtml(options.error)}</div>` : ""}
  ${options.success ? `<div class="success">${escapeHtml(options.success)}</div>` : ""}

  <h2>Your subscriptions</h2>
  ${subItems}`;

  return page("Subscriptions – Blog to EPUB", nav, body);
}

function renderSubItem(sub: Subscription): string {
  const lastChecked = sub.lastChecked
    ? `Last checked ${formatRelative(sub.lastChecked)}`
    : "Never checked";

  const epubList = sub.recentEpubs.length === 0
    ? `<p class="empty" style="margin:.4rem 0 0">No EPUBs yet – new posts will appear here after the next scheduled check.</p>`
    : `<ul class="sub-epubs">${sub.recentEpubs
        .map(
          (e) =>
            `<li><a href="/download/${escapeHtml(e.key)}" download>${escapeHtml(e.title)}</a>` +
            ` <span style="color:#999">(${formatDate(e.createdAt)})</span></li>`,
        )
        .join("")}</ul>`;

  return `
  <li class="sub-item">
    <div class="sub-item-header">
      <div>
        <p class="sub-title">${escapeHtml(sub.title)}</p>
        <p class="sub-meta">
          <a href="${escapeHtml(sub.siteUrl)}" target="_blank" rel="noopener">${escapeHtml(sub.siteUrl)}</a>
          &middot; ${escapeHtml(lastChecked)}
        </p>
      </div>
      <form method="POST" action="/subscriptions/${escapeHtml(sub.id)}/delete" style="flex-shrink:0">
        <button type="submit" class="danger" onclick="return confirm('Remove this subscription?')">Remove</button>
      </form>
    </div>
    ${epubList}
  </li>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
