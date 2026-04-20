import { useState } from "react";
import { Link } from "react-router-dom";
import { register } from "../api";

export default function RegisterPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await register(name.trim(), email.trim(), password);
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed.");
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div>
        <h2 className="font-heading text-lg font-bold text-brown mb-5">Request access</h2>
        <div className="px-4 py-4 bg-sage-bg border border-sage-border text-sage-text text-sm rounded-sm leading-relaxed">
          <p className="font-semibold mb-1">You're on the waitlist.</p>
          <p>You'll be able to sign in once your account has been approved.</p>
        </div>
        <p className="mt-6 text-xs text-brown-light text-center">
          Already approved?{" "}
          <Link to="/login" className="text-teal hover:text-teal-dark underline">
            Sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div>
      <h2 className="font-heading text-lg font-bold text-brown mb-5">Request access</h2>

      {error && (
        <div className="mb-4 px-3 py-2 bg-rose-bg border border-rose-border text-rose-text text-sm rounded-sm">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-mono uppercase tracking-widest text-brown-light">
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
            className="px-3 py-2 bg-parchment border border-tan rounded-sm text-sm text-brown focus:outline-none focus:ring-1 focus:ring-teal"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-mono uppercase tracking-widest text-brown-light">
            Email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="px-3 py-2 bg-parchment border border-tan rounded-sm text-sm text-brown focus:outline-none focus:ring-1 focus:ring-teal"
          />
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
            minLength={8}
            className="px-3 py-2 bg-parchment border border-tan rounded-sm text-sm text-brown focus:outline-none focus:ring-1 focus:ring-teal"
          />
          <p className="text-xs text-brown-light">Minimum 8 characters.</p>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="mt-1 bg-teal text-cream text-sm px-5 py-2 rounded-sm hover:bg-teal-dark disabled:opacity-50 cursor-pointer"
        >
          {loading ? "Submitting…" : "Request access"}
        </button>
      </form>

      <p className="mt-6 text-xs text-brown-light text-center">
        Already have an account?{" "}
        <Link to="/login" className="text-teal hover:text-teal-dark underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
