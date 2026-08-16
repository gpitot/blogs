import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { downloadEpub, getWeeklyBooks, sendEpub, setAutoSendWeekly } from "../api";
import type { WeeklyBookMeta } from "../types";

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function WeeklyBooksPage() {
  const [books, setBooks] = useState<WeeklyBookMeta[]>([]);
  const [sending, setSending] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [autoSend, setAutoSend] = useState<boolean | null>(null);
  const [savingAutoSend, setSavingAutoSend] = useState(false);

  useEffect(() => {
    getWeeklyBooks().then((data) => {
      setBooks(data.books);
      setAutoSend(data.autoSendWeekly);
    });
  }, []);

  async function handleResend(weekKey: string) {
    setSending(weekKey);
    try {
      await sendEpub("weekly", weekKey);
    } catch {
      // ignore
    } finally {
      setSending(null);
    }
  }

  async function handleDownload(book: WeeklyBookMeta) {
    setDownloadError(null);
    setDownloading(book.weekKey);
    try {
      await downloadEpub("weekly", book.weekKey, `${book.title}.epub`);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(null);
    }
  }

  async function handleToggleAutoSend(enabled: boolean) {
    const previous = autoSend;
    setAutoSend(enabled);
    setSavingAutoSend(true);
    try {
      const data = await setAutoSendWeekly(enabled);
      setAutoSend(data.autoSendWeekly);
    } catch {
      setAutoSend(previous);
    } finally {
      setSavingAutoSend(false);
    }
  }

  return (
    <div>
      <h2 className="font-heading text-xl font-bold mb-1 text-brown">Weekly Reading Books</h2>
      <p className="text-brown-light text-sm mb-5">
        Every Monday, a new EPUB is compiled from all new posts across your{" "}
        <Link to="/subscriptions" className="text-teal underline hover:text-teal-dark">
          subscriptions
        </Link>{" "}
        that week.
      </p>

      {autoSend !== null && (
        <div className="border border-tan rounded-sm p-3 bg-cream shadow-[1px_1px_4px_rgba(0,0,0,0.05)] mb-5">
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={autoSend}
              disabled={savingAutoSend}
              onChange={(e) => handleToggleAutoSend(e.target.checked)}
              className="mt-0.5 accent-teal cursor-pointer disabled:opacity-50"
            />
            <span>
              <span className="block font-medium text-sm text-brown">
                Email me each new weekly book
              </span>
              <span className="block text-xs text-brown-light">
                {autoSend
                  ? "Your book is sent automatically as soon as it is compiled."
                  : "Books are still compiled every Monday — send them yourself from the list below."}
              </span>
            </span>
          </label>
        </div>
      )}

      {downloadError && (
        <div className="mb-4 p-3 bg-rose-bg border border-rose-border text-rose-text rounded-sm text-sm">
          {downloadError}
        </div>
      )}

      {books.length === 0 ? (
        <p className="text-brown-light italic text-sm">
          No weekly books yet. Books are compiled every Monday from your subscription articles.
        </p>
      ) : (
        <ul className="space-y-2">
          {books.map((book) => (
            <li
              key={book.weekKey}
              className="flex items-center justify-between border border-tan rounded-sm p-3 bg-cream shadow-[1px_1px_4px_rgba(0,0,0,0.05)] gap-4"
            >
              <div>
                <p className="font-medium text-sm text-brown">{book.title}</p>
                <p className="text-xs text-brown-light">
                  {book.articleCount} article{book.articleCount !== 1 ? "s" : ""} &middot;{" "}
                  {Math.round(book.size / 1024)} KB &middot; {formatDate(book.createdAt)}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => handleDownload(book)}
                  disabled={downloading === book.weekKey}
                  className="px-3 py-1 border border-teal text-teal text-xs font-semibold rounded-sm hover:bg-teal hover:text-cream disabled:opacity-50 cursor-pointer uppercase tracking-wide"
                >
                  {downloading === book.weekKey ? "Preparing…" : "Download"}
                </button>
                <button
                  onClick={() => handleResend(book.weekKey)}
                  disabled={sending === book.weekKey}
                  className="px-3 py-1 bg-teal text-cream text-xs font-semibold rounded-sm hover:bg-teal-dark disabled:opacity-50 cursor-pointer uppercase tracking-wide"
                >
                  {sending === book.weekKey ? "Sending…" : "Send"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
