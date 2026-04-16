import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import ConvertPage from "./pages/ConvertPage";
import SubscriptionsPage from "./pages/SubscriptionsPage";
import WeeklyBooksPage from "./pages/WeeklyBooksPage";
import EmailPage from "./pages/EmailPage";

export default function App() {
  return (
    <BrowserRouter>
      <div className="max-w-2xl mx-auto px-5 py-16">
        <nav className="mb-8 flex gap-4 text-sm">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              isActive ? "font-semibold text-black" : "text-blue-600 hover:underline"
            }
          >
            Convert
          </NavLink>
          <NavLink
            to="/subscriptions"
            className={({ isActive }) =>
              isActive ? "font-semibold text-black" : "text-blue-600 hover:underline"
            }
          >
            Subscriptions
          </NavLink>
          <NavLink
            to="/weekly-books"
            className={({ isActive }) =>
              isActive ? "font-semibold text-black" : "text-blue-600 hover:underline"
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
        <footer className="mt-12 text-xs text-gray-400">Powered by Cloudflare Workers</footer>
      </div>
    </BrowserRouter>
  );
}
