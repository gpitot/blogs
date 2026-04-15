import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { getEmailMeta, sendEpub } from "../api";

export default function EmailPage() {
  const { type = "", id = "" } = useParams<{ type: string; id: string }>();
  const [title, setTitle] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);

  const backUrl =
    type === "weekly" ? "/weekly-books" : type === "article" ? "/subscriptions" : "/";

  useEffect(() => {
    getEmailMeta(type, id)
      .then((data) => setTitle(data.title))
      .catch((err) => setMetaError(err instanceof Error ? err.message : String(err)));
  }, [type, id]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const data = await sendEpub(email, type, id);
      setSuccess(data.success);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  if (metaError) {
    return (
      <div>
        <p className="text-red-700">{metaError}</p>
        <Link to={backUrl} className="text-blue-600 hover:underline text-sm mt-4 inline-block">
          ← Back
        </Link>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Send EPUB by Email</h1>
      {title && <p className="text-gray-500 mb-6">&ldquo;{title}&rdquo;</p>}

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-md">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 text-green-800 rounded-md">
          {success}
        </div>
      )}

      {!success && (
        <form onSubmit={handleSubmit}>
          <label className="block font-medium mb-1.5" htmlFor="email">
            Email address
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            autoComplete="email"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-base focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="submit"
            disabled={loading}
            className="mt-3 px-5 py-2 bg-blue-600 text-white font-semibold rounded-md hover:bg-blue-700 disabled:opacity-50 cursor-pointer"
          >
            {loading ? "Sending…" : "Send EPUB"}
          </button>
        </form>
      )}

      <Link to={backUrl} className="text-blue-600 hover:underline text-sm mt-6 inline-block">
        ← Back
      </Link>
    </div>
  );
}
