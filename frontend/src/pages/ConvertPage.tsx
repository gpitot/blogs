import { useState, useEffect } from "react";
import { getHome, convert, downloadEpub, sendEpub } from "../api";
import type { CachedArticleMeta } from "../types";

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function ConvertPage() {
  const [cachedArticles, setCachedArticles] = useState<CachedArticleMeta[]>([]);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    title: string;
    emailSentTo: string;
  } | null>(null);
  const [resending, setResending] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  useEffect(() => {
    getHome().then((data) => {
      setCachedArticles(data.cachedArticles);
    });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      const data = await convert(url);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleResend(cacheKey: string) {
    const shortKey = cacheKey.replace("epub:", "");
    setResending(shortKey);
    try {
      await sendEpub("cached", shortKey);
    } catch {
      // ignore
    } finally {
      setResending(null);
    }
  }

  async function handleDownload(article: CachedArticleMeta) {
    const shortKey = article.cacheKey.replace("epub:", "");
    setError(null);
    setDownloading(shortKey);
    try {
      await downloadEpub("cached", shortKey, `${article.title}.epub`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div>
      <h2 className="font-heading text-xl font-bold mb-1 text-brown">Convert Article</h2>
      <p className="text-brown-light text-sm mb-5">
        Paste a blog post URL and receive it as an EPUB in your inbox.
      </p>

      <form onSubmit={handleSubmit}>
        <label className="block font-medium text-sm mb-1" htmlFor="url">
          Blog post URL
        </label>
        <input
          id="url"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/post/article-title"
          required
          autoComplete="off"
          className="w-full px-3 py-2 bg-parchment border border-tan rounded-sm text-sm text-brown shadow-[inset_1px_1px_3px_rgba(0,0,0,0.06)] focus:outline-none focus:ring-1 focus:ring-teal focus:border-teal"
        />
        <button
          type="submit"
          disabled={loading}
          className="mt-3 px-5 py-2 bg-teal text-cream text-sm font-semibold rounded-sm hover:bg-teal-dark disabled:opacity-50 cursor-pointer tracking-wide uppercase"
        >
          {loading ? "Converting\u2026" : "Convert & Send"}
        </button>
      </form>

      {error && (
        <div className="mt-4 p-3 bg-rose-bg border border-rose-border text-rose-text rounded-sm text-sm">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-4 p-3 bg-sage-bg border border-sage-border text-sage-text rounded-sm text-sm">
          <strong>{result.title}</strong> sent to <strong>{result.emailSentTo}</strong>.
        </div>
      )}

      {cachedArticles.length > 0 && (
        <div>
          <h3 className="font-heading text-lg font-bold mt-8 mb-3 text-brown">
            Recent Conversions
          </h3>
          <ul className="space-y-2">
            {cachedArticles.map((a) => {
              const shortKey = a.cacheKey.replace("epub:", "");
              return (
                <li
                  key={a.cacheKey}
                  className="flex items-center justify-between border border-tan rounded-sm p-3 bg-cream shadow-[1px_1px_4px_rgba(0,0,0,0.05)] gap-4"
                >
                  <div>
                    <p className="font-medium text-sm text-brown">{a.title}</p>
                    <p className="text-xs text-brown-light">
                      {Math.round(a.size / 1024)} KB &middot; {formatDate(a.createdAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => handleDownload(a)}
                      disabled={downloading === shortKey}
                      className="px-3 py-1 border border-teal text-teal text-xs font-semibold rounded-sm hover:bg-teal hover:text-cream disabled:opacity-50 cursor-pointer uppercase tracking-wide"
                    >
                      {downloading === shortKey ? "Preparing\u2026" : "Download"}
                    </button>
                    <button
                      onClick={() => handleResend(a.cacheKey)}
                      disabled={resending === shortKey}
                      className="px-3 py-1 bg-teal text-cream text-xs font-semibold rounded-sm hover:bg-teal-dark disabled:opacity-50 cursor-pointer uppercase tracking-wide"
                    >
                      {resending === shortKey ? "Sending\u2026" : "Send"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
