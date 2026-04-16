import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import ConvertPage from "./pages/ConvertPage";
import SubscriptionsPage from "./pages/SubscriptionsPage";
import WeeklyBooksPage from "./pages/WeeklyBooksPage";
import EmailPage from "./pages/EmailPage";

export default function App() {
  return (
    <BrowserRouter>
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
          </nav>

          <Routes>
            <Route path="/" element={<ConvertPage />} />
            <Route path="/subscriptions" element={<SubscriptionsPage />} />
            <Route path="/weekly-books" element={<WeeklyBooksPage />} />
            <Route path="/email/:type/:id" element={<EmailPage />} />
          </Routes>

          <footer className="mt-10 pt-4 border-t border-dashed border-tan text-xs text-brown-light italic text-center">
            Pitot
          </footer>
        </div>
      </div>
    </BrowserRouter>
  );
}
