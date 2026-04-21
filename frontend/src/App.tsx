import { useState, useEffect } from "react";
import { BrowserRouter, Routes, Route, NavLink, Navigate, useNavigate } from "react-router-dom";
import ConvertPage from "./pages/ConvertPage";
import SubscriptionsPage from "./pages/SubscriptionsPage";
import WeeklyBooksPage from "./pages/WeeklyBooksPage";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import { getHome, logout, onUnauthorized } from "./api";

export default function App() {
  return (
    <BrowserRouter>
      <AppInner />
    </BrowserRouter>
  );
}

type AuthState = "loading" | "authenticated" | "unauthenticated";

function AppInner() {
  const navigate = useNavigate();
  const [authState, setAuthState] = useState<AuthState>("loading");

  useEffect(() => {
    onUnauthorized(() => {
      setAuthState("unauthenticated");
      const path = window.location.pathname;
      if (path !== "/login" && path !== "/register") {
        navigate("/login");
      }
    });
    getHome()
      .then(() => setAuthState("authenticated"))
      .catch(() => setAuthState("unauthenticated"));
  }, [navigate]);

  const handleLogout = async () => {
    try {
      await logout();
    } catch {
      // ignore errors — clear state regardless
    }
    setAuthState("unauthenticated");
    navigate("/login");
  };

  return (
    <div className="max-w-2xl mx-auto px-6 py-12">
      <div className="bg-cream border border-tan rounded-sm shadow-[2px_3px_8px_rgba(0,0,0,0.08)] px-8 py-8">
        <header className="mb-6">
          <h1 className="font-heading text-3xl font-bold tracking-tight text-brown">
            Blog to EPUB
          </h1>
          <p className="text-brown-light text-xs mt-1 italic">
            A quiet utility for the digital reader
          </p>
          <hr className="mt-3 border-t-2 border-dashed border-tan" />
        </header>

        {authState === "loading" && (
          <div className="py-12 text-center text-brown-light text-sm italic">Loading…</div>
        )}

        {authState === "authenticated" && (
          <>
            <nav className="mb-8 flex items-center gap-1 text-xs font-mono uppercase tracking-widest">
              <NavLink
                to="/"
                end
                className={({ isActive }) =>
                  isActive
                    ? "font-semibold text-brown border-b-2 border-brown pb-0.5"
                    : "text-teal hover:text-teal-dark pb-0.5"
                }
              >
                Convert
              </NavLink>
              <span className="text-tan-dark mx-2">|</span>
              <NavLink
                to="/subscriptions"
                className={({ isActive }) =>
                  isActive
                    ? "font-semibold text-brown border-b-2 border-brown pb-0.5"
                    : "text-teal hover:text-teal-dark pb-0.5"
                }
              >
                Subscriptions
              </NavLink>
              <span className="text-tan-dark mx-2">|</span>
              <NavLink
                to="/weekly-books"
                className={({ isActive }) =>
                  isActive
                    ? "font-semibold text-brown border-b-2 border-brown pb-0.5"
                    : "text-teal hover:text-teal-dark pb-0.5"
                }
              >
                Weekly Books
              </NavLink>
              <span className="flex-1" />
              <button
                onClick={handleLogout}
                className="text-brown-light hover:text-brown pb-0.5 normal-case tracking-normal"
              >
                Log out
              </button>
            </nav>

            <Routes>
              <Route path="/" element={<ConvertPage />} />
              <Route path="/subscriptions" element={<SubscriptionsPage />} />
              <Route path="/weekly-books" element={<WeeklyBooksPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </>
        )}

        {authState === "unauthenticated" && (
          <Routes>
            <Route
              path="/login"
              element={
                <LoginPage
                  onSuccess={() => {
                    setAuthState("authenticated");
                    navigate("/");
                  }}
                />
              }
            />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        )}

        <footer className="mt-10 pt-4 border-t border-dashed border-tan text-xs text-brown-light italic text-center">
          Pitot
        </footer>
      </div>
    </div>
  );
}
