import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import {
  getSubscriptions,
  getPopularSubscriptions,
  subscribe,
  deleteSubscription,
  sendEpub,
  downloadEpub,
} from "../api";
import type { PopularSubscription } from "../api";
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
  const [popular, setPopular] = useState<PopularSubscription[]>([]);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [addingFeed, setAddingFeed] = useState<string | null>(null);

  useEffect(() => {
    getSubscriptions().then((data) => {
      setSubs(data.subscriptions);
    });
    getPopularSubscriptions().then((data) => {
      setPopular(data.popular);
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

  async function handleAddPopular(feedUrl: string) {
    setError(null);
    setSuccess(null);
    setAddingFeed(feedUrl);
    try {
      const data = await subscribe(feedUrl);
      setSuccess(data.message);
      const updated = await getSubscriptions();
      setSubs(updated.subscriptions);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingFeed(null);
    }
  }

  async function handleDelete(feedId: string) {
    if (!confirm("Remove this subscription?")) return;
    await deleteSubscription(feedId);
    setSubs((prev) => prev.filter((s) => s.feedId !== feedId));
  }

  async function handleResend(articleId: string) {
    setSending(articleId);
    try {
      await sendEpub("article", articleId);
    } catch {
      // ignore
    } finally {
      setSending(null);
    }
  }

  async function handleDownload(articleId: string, title: string) {
    setError(null);
    setDownloading(articleId);
    try {
      await downloadEpub("article", articleId, `${title}.epub`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div>
      <h2 className="font-heading text-xl font-bold mb-1 text-brown">Blog Subscriptions</h2>
      <p className="text-brown-light text-sm mb-5">
        Subscribe to a blog&apos;s RSS feed. New posts are saved automatically and compiled into a{" "}
        <Link to="/weekly-books" className="text-teal underline hover:text-teal-dark">
          weekly book
        </Link>{" "}
        every Monday.
      </p>

      <form onSubmit={handleSubscribe}>
        <label className="block font-medium text-sm mb-1" htmlFor="sub-url">
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
          className="w-full px-3 py-2 bg-parchment border border-tan rounded-sm text-sm text-brown shadow-[inset_1px_1px_3px_rgba(0,0,0,0.06)] focus:outline-none focus:ring-1 focus:ring-teal focus:border-teal"
        />
        <button
          type="submit"
          disabled={loading}
          className="mt-3 px-5 py-2 bg-teal text-cream text-sm font-semibold rounded-sm hover:bg-teal-dark disabled:opacity-50 cursor-pointer tracking-wide uppercase"
        >
          {loading ? "Subscribing\u2026" : "Subscribe"}
        </button>
      </form>

      {error && (
        <div className="mt-4 p-3 bg-rose-bg border border-rose-border text-rose-text rounded-sm text-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="mt-4 p-3 bg-sage-bg border border-sage-border text-sage-text rounded-sm text-sm">
          {success}
        </div>
      )}

      <h3 className="font-heading text-lg font-bold mt-8 mb-3 text-brown">Your Subscriptions</h3>

      {subs.length === 0 ? (
        <p className="text-brown-light italic text-sm">
          No subscriptions yet. Add a blog above to get started.
        </p>
      ) : (
        <ul className="space-y-3">
          {subs.map((sub) => (
            <li
              key={sub.feedId}
              className="border border-tan rounded-sm p-4 bg-cream shadow-[1px_1px_4px_rgba(0,0,0,0.05)]"
            >
              <div className="flex justify-between items-start gap-2">
                <div>
                  <p className="font-heading font-bold text-brown">{sub.title}</p>
                  <p className="text-xs text-brown-light mt-0.5">
                    <a
                      href={sub.siteUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-teal hover:underline"
                    >
                      {sub.siteUrl}
                    </a>
                    {" \u00b7 "}
                    {sub.lastChecked
                      ? `Last checked ${formatRelative(sub.lastChecked)}`
                      : "Never checked"}
                  </p>
                </div>
                <button
                  onClick={() => handleDelete(sub.feedId)}
                  className="shrink-0 px-2.5 py-1 bg-rose-bg border border-rose-border text-rose-text text-xs font-semibold rounded-sm hover:bg-rose-text hover:text-cream cursor-pointer"
                >
                  Remove
                </button>
              </div>

              {(sub.convertedArticles ?? []).length === 0 ? (
                <p className="text-xs text-brown-light italic mt-2">
                  No articles yet &ndash; new posts will appear here after the next scheduled check.
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-brown-light/20">
                  {(sub.convertedArticles ?? []).map((a) => (
                    <li key={a.articleId} className="py-1.5 first:pt-0">
                      <span className="text-sm text-brown">{a.title}</span>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-brown-light text-xs">{formatDate(a.createdAt)}</span>
                        <button
                          onClick={() => handleResend(a.articleId)}
                          disabled={sending === a.articleId}
                          className="text-xs text-teal hover:underline cursor-pointer disabled:opacity-50"
                        >
                          {sending === a.articleId ? "Sending\u2026" : "Email"}
                        </button>
                        <button
                          onClick={() => handleDownload(a.articleId, a.title)}
                          disabled={downloading === a.articleId}
                          className="text-xs text-teal hover:underline cursor-pointer disabled:opacity-50"
                        >
                          {downloading === a.articleId ? "Preparing\u2026" : "Download"}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      {popular.length > 0 && (
        <>
          <h3 className="font-heading text-lg font-bold mt-8 mb-3 text-brown">Popular Blogs</h3>
          <ul className="space-y-2">
            {popular.map((p) => (
              <li
                key={p.feedUrl}
                className="flex items-center justify-between border border-tan rounded-sm p-3 bg-cream shadow-[1px_1px_4px_rgba(0,0,0,0.05)] gap-4"
              >
                <div>
                  <p className="font-medium text-sm text-brown">{p.title}</p>
                  <p className="text-xs text-brown-light">
                    <a
                      href={p.siteUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-teal hover:underline"
                    >
                      {p.siteUrl}
                    </a>
                    {" \u00b7 "}
                    {p.subscriberCount} subscriber{p.subscriberCount !== 1 ? "s" : ""}
                  </p>
                </div>
                {!subs.some((s) => s.feedUrl === p.feedUrl) && (
                  <button
                    onClick={() => handleAddPopular(p.feedUrl)}
                    disabled={addingFeed === p.feedUrl}
                    className="px-3 py-1 bg-teal text-cream text-xs font-semibold rounded-sm hover:bg-teal-dark cursor-pointer uppercase tracking-wide shrink-0 disabled:opacity-50"
                  >
                    {addingFeed === p.feedUrl ? "Adding\u2026" : "Add"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
