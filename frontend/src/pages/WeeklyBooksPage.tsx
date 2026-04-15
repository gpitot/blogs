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
      <h1 className="text-2xl font-bold mb-1">Weekly Reading Books</h1>
      <p className="text-gray-500 mb-6">
        Every Monday, a new EPUB is compiled from all new posts across your{" "}
        <Link to="/subscriptions" className="text-blue-600 hover:underline">
          subscriptions
        </Link>{" "}
        that week.
      </p>

      {books.length === 0 ? (
        <p className="text-gray-400 italic text-sm">
          No weekly books yet. Books are compiled every Monday from your subscription articles.
        </p>
      ) : (
        <ul className="space-y-2">
          {books.map((book) => (
            <li
              key={book.weekKey}
              className="flex items-center justify-between border border-gray-200 rounded-lg p-3 bg-white gap-4"
            >
              <div>
                <p className="font-semibold text-sm">{book.title}</p>
                <p className="text-xs text-gray-500">
                  {book.articleCount} article{book.articleCount !== 1 ? "s" : ""} ·{" "}
                  {Math.round(book.size / 1024)} KB · {formatDate(book.createdAt)}
                </p>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <a
                  href={downloadUrl(`/download/weekly/${book.weekKey}`)}
                  className="px-3 py-1 bg-blue-600 text-white text-sm font-semibold rounded hover:bg-blue-700"
                >
                  Download
                </a>
                {emailEnabled && (
                  <Link
                    to={`/email/weekly/${book.weekKey}`}
                    className="text-xs text-blue-600 hover:underline"
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
