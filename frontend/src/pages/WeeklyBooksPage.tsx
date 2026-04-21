import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { getWeeklyBooks, sendEpub } from "../api";
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

  useEffect(() => {
    getWeeklyBooks().then((data) => {
      setBooks(data.books);
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
              <button
                onClick={() => handleResend(book.weekKey)}
                disabled={sending === book.weekKey}
                className="px-3 py-1 bg-teal text-cream text-xs font-semibold rounded-sm hover:bg-teal-dark disabled:opacity-50 cursor-pointer uppercase tracking-wide shrink-0"
              >
                {sending === book.weekKey ? "Sending\u2026" : "Send"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
