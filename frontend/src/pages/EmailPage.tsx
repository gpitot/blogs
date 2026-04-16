import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { getEmailMeta, sendEpub } from "../api";
import KindleHelp from "../KindleHelp";

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
        <p className="text-rose-text">{metaError}</p>
        <Link to={backUrl} className="text-teal hover:underline text-sm mt-4 inline-block">
          &larr; Back
        </Link>
      </div>
    );
  }

  return (
    <div>
      <h2 className="font-heading text-xl font-bold mb-1 text-brown">Send EPUB by Email</h2>
      {title && (
        <p className="text-brown-light text-sm mb-5 italic">&ldquo;{title}&rdquo;</p>
      )}

      {error && (
        <div className="mb-4 p-3 bg-rose-bg border border-rose-border text-rose-text rounded-sm text-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 p-3 bg-sage-bg border border-sage-border text-sage-text rounded-sm text-sm">
          {success}
        </div>
      )}

      {!success && (
        <form onSubmit={handleSubmit}>
          <label className="block font-medium text-sm mb-1" htmlFor="email">
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
            className="w-full px-3 py-2 bg-parchment border border-tan rounded-sm text-sm text-brown shadow-[inset_1px_1px_3px_rgba(0,0,0,0.06)] focus:outline-none focus:ring-1 focus:ring-teal focus:border-teal"
          />
          <KindleHelp />
          <button
            type="submit"
            disabled={loading}
            className="mt-3 px-5 py-2 bg-teal text-cream text-sm font-semibold rounded-sm hover:bg-teal-dark disabled:opacity-50 cursor-pointer tracking-wide uppercase"
          >
            {loading ? "Sending\u2026" : "Send EPUB"}
          </button>
        </form>
      )}

      <Link to={backUrl} className="text-teal hover:underline text-sm mt-6 inline-block">
        &larr; Back
      </Link>
    </div>
  );
}
