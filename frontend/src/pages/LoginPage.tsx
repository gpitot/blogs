import { useState } from "react";
import { Link } from "react-router-dom";
import { login } from "../api";
import KindleHelp from "../KindleHelp";

interface Props {
  onSuccess: () => void;
}

export default function LoginPage({ onSuccess }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(email.trim(), password);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h2 className="font-heading text-lg font-bold text-brown mb-5">Sign in</h2>

      {error && (
        <div className="mb-4 px-3 py-2 bg-rose-bg border border-rose-border text-rose-text text-sm rounded-sm">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-mono uppercase tracking-widest text-brown-light">
            Kindle Email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
            className="px-3 py-2 bg-parchment border border-tan rounded-sm text-sm text-brown focus:outline-none focus:ring-1 focus:ring-teal"
          />
          <KindleHelp />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-mono uppercase tracking-widest text-brown-light">
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="px-3 py-2 bg-parchment border border-tan rounded-sm text-sm text-brown focus:outline-none focus:ring-1 focus:ring-teal"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="mt-1 bg-teal text-cream text-sm px-5 py-2 rounded-sm hover:bg-teal-dark disabled:opacity-50 cursor-pointer"
        >
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <p className="mt-6 text-xs text-brown-light text-center">
        No account?{" "}
        <Link to="/register" className="text-teal hover:text-teal-dark underline">
          Request access
        </Link>
      </p>
    </div>
  );
}
