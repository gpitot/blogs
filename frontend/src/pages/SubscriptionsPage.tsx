import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { getSubscriptions, subscribe, deleteSubscription, downloadUrl } from "../api";
import type { Subscription } from "../types";

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
  return `${Math.floor(hours / 24)}d ago`;
}

export default function SubscriptionsPage() {
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    getSubscriptions().then((data) => {
      setSubs(data.subscriptions);
      setEmailEnabled(data.emailEnabled);
    });
  }, []);

  async function handleSubscribe(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setLoading(true);
    try {
      const data = await subscribe(url);
      setSuccess(data.message);
      setUrl("");
      const updated = await getSubscriptions();
      setSubs(updated.subscriptions);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Remove this subscription?")) return;
    await deleteSubscription(id);
    setSubs((prev) => prev.filter((s) => s.id !== id));
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Blog Subscriptions</h1>
      <p className="text-gray-500 mb-6">
        Subscribe to a blog&apos;s RSS feed. New posts are saved automatically and compiled into a{" "}
        <Link to="/weekly-books" className="text-blue-600 hover:underline">
          weekly book
        </Link>{" "}
        every Monday.
      </p>

      <form onSubmit={handleSubscribe}>
        <label className="block font-medium mb-1.5" htmlFor="sub-url">
          Blog or feed URL
        </label>
        <input
          id="sub-url"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com or https://example.com/feed"
          required
          autoComplete="off"
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-base focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          type="submit"
          disabled={loading}
          className="mt-3 px-5 py-2 bg-blue-600 text-white font-semibold rounded-md hover:bg-blue-700 disabled:opacity-50 cursor-pointer"
        >
          {loading ? "Subscribing…" : "Subscribe"}
        </button>
      </form>

      {error && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-md">
          {error}
        </div>
      )}
      {success && (
        <div className="mt-4 p-3 bg-green-50 border border-green-200 text-green-800 rounded-md">
          {success}
        </div>
      )}

      <h2 className="text-lg font-semibold mt-7 mb-3">Your subscriptions</h2>

      {subs.length === 0 ? (
        <p className="text-gray-400 italic text-sm">
          No subscriptions yet. Add a blog above to get started.
        </p>
      ) : (
        <ul className="space-y-3">
          {subs.map((sub) => (
            <li key={sub.id} className="border border-gray-200 rounded-lg p-4 bg-white">
              <div className="flex justify-between items-start gap-2">
                <div>
                  <p className="font-semibold">{sub.title}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    <a
                      href={sub.siteUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline"
                    >
                      {sub.siteUrl}
                    </a>
                    {" · "}
                    {sub.lastChecked
                      ? `Last checked ${formatRelative(sub.lastChecked)}`
                      : "Never checked"}
                  </p>
                </div>
                <button
                  onClick={() => handleDelete(sub.id)}
                  className="shrink-0 px-2.5 py-1 bg-red-600 text-white text-xs font-semibold rounded hover:bg-red-700 cursor-pointer"
                >
                  Remove
                </button>
              </div>

              {sub.recentArticles.length === 0 ? (
                <p className="text-xs text-gray-400 italic mt-2">
                  No articles yet – new posts will appear here after the next scheduled check.
                </p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {sub.recentArticles.map((a) => (
                    <li key={a.id} className="text-sm flex items-center gap-2 flex-wrap">
                      <a
                        href={downloadUrl(`/download/article/${a.id}`)}
                        className="text-blue-600 hover:underline"
                      >
                        {a.title}
                      </a>
                      <span className="text-gray-400 text-xs">{formatDate(a.createdAt)}</span>
                      {emailEnabled && (
                        <Link
                          to={`/email/article/${a.id}`}
                          className="text-xs text-blue-600 hover:underline"
                        >
                          Email
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
