import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { getWeeklyBooks, downloadUrl } from "../api";
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
  const [emailEnabled, setEmailEnabled] = useState(false);

  useEffect(() => {
    getWeeklyBooks().then((data) => {
      setBooks(data.books);
      setEmailEnabled(data.emailEnabled);
    });
  }, []);

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
              <div className="flex flex-col items-end gap-1 shrink-0">
                <a
                  href={downloadUrl(`/download/weekly/${book.weekKey}`)}
                  className="px-3 py-1 bg-teal text-cream text-xs font-semibold rounded-sm hover:bg-teal-dark uppercase tracking-wide"
                >
                  Download
                </a>
                {emailEnabled && (
                  <Link
                    to={`/email/weekly/${book.weekKey}`}
                    className="text-xs text-teal hover:underline"
                  >
                    Send to email
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
