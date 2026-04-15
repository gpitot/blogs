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
      <h1 className="text-2xl font-bold mb-1">Blog to EPUB</h1>
      <p className="text-gray-500 mb-6">
        Paste a blog post URL and download it as an EPUB for your e-reader.
      </p>

      <form onSubmit={handleSubmit}>
        <label className="block font-medium mb-1.5" htmlFor="url">
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
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-base focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {emailEnabled && (
          <>
            <label className="block font-medium mt-3 mb-1.5" htmlFor="email">
              Email address{" "}
              <span className="font-normal text-gray-400">
                (optional – receive EPUB in your inbox)
              </span>
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-base focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </>
        )}
        <button
          type="submit"
          disabled={loading}
          className="mt-3 px-5 py-2 bg-blue-600 text-white font-semibold rounded-md hover:bg-blue-700 disabled:opacity-50 cursor-pointer"
        >
          {loading ? "Converting…" : "Convert to EPUB"}
        </button>
      </form>

      {error && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-md">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-md">
          {result.emailSentTo ? (
            <>
              EPUB sent to <strong>{result.emailSentTo}</strong>.{" "}
            </>
          ) : (
            "Your EPUB is ready: "
          )}
          <a
            href={downloadUrl(result.downloadUrl)}
            className="text-green-700 font-semibold hover:underline"
          >
            {result.emailSentTo ? "Download directly" : result.downloadTitle}
          </a>
        </div>
      )}

      {cachedArticles.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mt-7 mb-3">Recent Conversions</h2>
          <ul className="space-y-2">
            {cachedArticles.map((a) => {
              const shortKey = a.cacheKey.replace("epub:", "");
              return (
                <li
                  key={a.cacheKey}
                  className="flex items-center justify-between border border-gray-200 rounded-lg p-3 bg-white gap-4"
                >
                  <div>
                    <p className="font-semibold text-sm">{a.title}</p>
                    <p className="text-xs text-gray-500">
                      {Math.round(a.size / 1024)} KB · {formatDate(a.createdAt)}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <a
                      href={downloadUrl(`/download/${shortKey}`)}
                      className="px-3 py-1 bg-blue-600 text-white text-sm font-semibold rounded hover:bg-blue-700"
                    >
                      Download
                    </a>
                    {emailEnabled && (
                      <Link
                        to={`/email/cached/${shortKey}`}
                        className="text-xs text-blue-600 hover:underline"
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
