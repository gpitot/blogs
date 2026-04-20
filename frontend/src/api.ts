import type { CachedArticleMeta, Subscription, WeeklyBookMeta } from "./types";

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "";

type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

export function onUnauthorized(handler: UnauthorizedHandler) {
  unauthorizedHandler = handler;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: "include",
  });

  if (res.status === 401) {
    unauthorizedHandler?.();
    throw new Error("Unauthorized");
  }

  const data = await res.json();
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `Request failed: ${res.status}`);
  }
  return data as T;
}

export function getHome() {
  return request<{ emailEnabled: boolean; cachedArticles: CachedArticleMeta[] }>("/");
}

export function convert(url: string, email?: string) {
  return request<{ downloadUrl: string; downloadTitle: string; emailSentTo?: string }>(
    "/convert",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, email }),
    },
  );
}

export function getSubscriptions() {
  return request<{ subscriptions: Subscription[]; emailEnabled: boolean }>("/subscriptions");
}

export function subscribe(url: string) {
  return request<{ subscription: Subscription; message: string }>("/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

export function deleteSubscription(id: string) {
  return request<{ success: boolean }>(`/subscriptions/${id}/delete`, { method: "POST" });
}

export function getWeeklyBooks() {
  return request<{ books: WeeklyBookMeta[]; emailEnabled: boolean }>("/weekly-books");
}

export function getEmailMeta(type: string, id: string) {
  return request<{ epubType: string; epubId: string; title: string }>(`/email/${type}/${id}`);
}

export function sendEpub(email: string, epubType: string, epubId: string) {
  return request<{ success: string }>("/send-epub", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, epub_type: epubType, epub_id: epubId }),
  });
}

export function register(name: string, email: string, password: string) {
  return request<{ message: string }>("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password }),
  });
}

export function login(email: string, password: string) {
  return request<{ message: string }>("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

export function logout() {
  return request<{ message: string }>("/logout", { method: "POST" });
}

/** Returns the full URL to a backend download path. */
export function downloadUrl(path: string): string {
  return `${API_BASE}${path}`;
}
