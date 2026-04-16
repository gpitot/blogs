import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { getHome, convert, downloadUrl } from "../api";
import type { CachedArticleMeta } from "../types";

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function ConvertPage() {
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [cachedArticles, setCachedArticles] = useState<CachedArticleMeta[]>([]);
  const [url, setUrl] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    downloadUrl: string;
    downloadTitle: string;
    emailSentTo?: string;
  } | null>(null);

  useEffect(() => {
    getHome().then((data) => {
      setEmailEnabled(data.emailEnabled);
      setCachedArticles(data.cachedArticles);
    });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      const data = await convert(url, email || undefined);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h2 className="font-heading text-xl font-bold mb-1 text-brown">Convert Article</h2>
      <p className="text-brown-light text-sm mb-5">
        Paste a blog post URL and download it as an EPUB for your e-reader.
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
        {emailEnabled && (
          <>
            <label className="block font-medium text-sm mt-3 mb-1" htmlFor="email">
              Email address{" "}
              <span className="font-normal text-brown-light italic">
                (optional &ndash; receive EPUB in your inbox)
              </span>
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              className="w-full px-3 py-2 bg-parchment border border-tan rounded-sm text-sm text-brown shadow-[inset_1px_1px_3px_rgba(0,0,0,0.06)] focus:outline-none focus:ring-1 focus:ring-teal focus:border-teal"
            />
          </>
        )}
        <button
          type="submit"
          disabled={loading}
          className="mt-3 px-5 py-2 bg-teal text-cream text-sm font-semibold rounded-sm hover:bg-teal-dark disabled:opacity-50 cursor-pointer tracking-wide uppercase"
        >
          {loading ? "Converting\u2026" : "Convert to EPUB"}
        </button>
      </form>

      {error && (
        <div className="mt-4 p-3 bg-rose-bg border border-rose-border text-rose-text rounded-sm text-sm">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-4 p-3 bg-sage-bg border border-sage-border text-sage-text rounded-sm text-sm">
          {result.emailSentTo ? (
            <>
              EPUB sent to <strong>{result.emailSentTo}</strong>.{" "}
            </>
          ) : (
            "Your EPUB is ready: "
          )}
          <a
            href={downloadUrl(result.downloadUrl)}
            className="font-semibold underline hover:text-teal-dark"
          >
            {result.emailSentTo ? "Download directly" : result.downloadTitle}
          </a>
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
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <a
                      href={downloadUrl(`/download/${shortKey}`)}
                      className="px-3 py-1 bg-teal text-cream text-xs font-semibold rounded-sm hover:bg-teal-dark uppercase tracking-wide"
                    >
                      Download
                    </a>
                    {emailEnabled && (
                      <Link
                        to={`/email/cached/${shortKey}`}
                        className="text-xs text-teal hover:underline"
                      >
                        Send to email
                      </Link>
                    )}
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
