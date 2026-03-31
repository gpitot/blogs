import type { Subscription, WeeklyBookMeta } from "./repositories/types.ts";

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
  .book-list { list-style: none; padding: 0; margin: 0; }
  .book-item {
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    padding: .85rem 1rem;
    margin-bottom: .75rem;
    background: #fff;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
  }
  .book-info { flex: 1; }
  .book-title { font-weight: 600; font-size: 1rem; margin: 0 0 .2rem; }
  .book-meta { font-size: .8rem; color: #666; }
  .book-download {
    display: inline-block;
    padding: .4rem 1rem;
    font-size: .9rem;
    font-weight: 600;
    color: #fff;
    background: #0070f3;
    border-radius: 6px;
    text-decoration: none;
    white-space: nowrap;
  }
  .book-download:hover { background: #005bcc; }
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

function nav(active: "convert" | "subscriptions" | "weekly-books"): string {
  const link = (href: string, label: string, key: typeof active) =>
    `<a href="${href}"${active === key ? ' class="active"' : ""}>${label}</a>`;
  return (
    link("/", "Convert", "convert") +
    link("/subscriptions", "Subscriptions", "subscriptions") +
    link("/weekly-books", "Weekly Books", "weekly-books")
  );
}

// ---------------------------------------------------------------------------
// Convert page
// ---------------------------------------------------------------------------

interface UIOptions {
  error?: string;
  downloadUrl?: string;
  downloadTitle?: string;
}

export function renderUI(options: UIOptions = {}): Response {
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

  return page("Blog to EPUB", nav("convert"), body);
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
  const subItems = subs.length === 0
    ? `<p class="empty">No subscriptions yet. Add a blog below to get started.</p>`
    : `<ul class="sub-list">${subs.map(renderSubItem).join("")}</ul>`;

  const body = `
  <h1>Blog Subscriptions</h1>
  <p class="subtitle">Subscribe to a blog's RSS feed. New posts are saved automatically and compiled into a <a href="/weekly-books">weekly book</a> every Monday.</p>

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

  return page("Subscriptions – Blog to EPUB", nav("subscriptions"), body);
}

function renderSubItem(sub: Subscription): string {
  const lastChecked = sub.lastChecked
    ? `Last checked ${formatRelative(sub.lastChecked)}`
    : "Never checked";

  const articles = sub.recentArticles;
  const articleList = articles.length === 0
    ? `<p class="empty" style="margin:.4rem 0 0">No articles yet – new posts will appear here after the next scheduled check.</p>`
    : `<ul class="sub-epubs">${articles
        .map(
          (a) =>
            `<li><a href="/download/article/${escapeHtml(a.id)}" download>${escapeHtml(a.title)}</a>` +
            ` <span style="color:#999">(${formatDate(a.createdAt)})</span></li>`,
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
    ${articleList}
  </li>`;
}

// ---------------------------------------------------------------------------
// Weekly books page
// ---------------------------------------------------------------------------

export function renderWeeklyBooksUI(books: WeeklyBookMeta[]): Response {
  const bookItems = books.length === 0
    ? `<p class="empty">No weekly books yet. Books are compiled every Monday from your subscription articles.</p>`
    : `<ul class="book-list">${books.map(renderBookItem).join("")}</ul>`;

  const body = `
  <h1>Weekly Reading Books</h1>
  <p class="subtitle">Every Monday, a new EPUB is compiled from all new posts across your <a href="/subscriptions">subscriptions</a> that week.</p>
  ${bookItems}`;

  return page("Weekly Books – Blog to EPUB", nav("weekly-books"), body);
}

function renderBookItem(book: WeeklyBookMeta): string {
  return `
  <li class="book-item">
    <div class="book-info">
      <p class="book-title">${escapeHtml(book.title)}</p>
      <p class="book-meta">${book.articleCount} article${book.articleCount !== 1 ? "s" : ""} &middot; ${Math.round(book.size / 1024)} KB &middot; ${formatDate(book.createdAt)}</p>
    </div>
    <a class="book-download" href="/download/weekly/${escapeHtml(book.weekKey)}" download>Download</a>
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
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
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
