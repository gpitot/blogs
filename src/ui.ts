interface UIOptions {
  error?: string;
  downloadUrl?: string;
  downloadTitle?: string;
}

export function renderUI(options: UIOptions = {}): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Blog to EPUB</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      max-width: 560px;
      margin: 5rem auto;
      padding: 0 1.25rem;
      color: #1a1a1a;
      background: #fafafa;
    }
    h1 { font-size: 1.75rem; margin-bottom: .25rem; }
    p.subtitle { color: #555; margin-top: 0; margin-bottom: 1.5rem; }
    label { display: block; font-weight: 500; margin-bottom: .35rem; }
    input[type=url] {
      width: 100%;
      padding: .55rem .75rem;
      font-size: 1rem;
      border: 1px solid #ccc;
      border-radius: 6px;
      background: #fff;
    }
    input[type=url]:focus { outline: 2px solid #0070f3; border-color: transparent; }
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
    .success a {
      color: #237804;
      font-weight: 600;
      text-decoration: none;
    }
    .success a:hover { text-decoration: underline; }
    footer { margin-top: 3rem; font-size: .8rem; color: #aaa; }
  </style>
</head>
<body>
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
    : ""}

  <footer>Powered by Cloudflare Workers</footer>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
