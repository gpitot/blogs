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
  return request<{ cachedArticles: CachedArticleMeta[] }>("/");
}

export function convert(url: string) {
  return request<{ title: string; emailSentTo: string }>(
    "/convert",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    },
  );
}

export interface PopularSubscription {
  feedUrl: string;
  siteUrl: string;
  title: string;
  subscriberCount: number;
}

export function getSubscriptions() {
  return request<{ subscriptions: Subscription[] }>("/subscriptions");
}

export function getPopularSubscriptions() {
  return request<{ popular: PopularSubscription[] }>("/subscriptions/popular");
}

export function subscribe(url: string) {
  return request<{ subscription: Subscription; message: string }>("/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

export function deleteSubscription(feedId: string) {
  return request<{ success: boolean }>(`/subscriptions/${feedId}/delete`, { method: "POST" });
}

export function getWeeklyBooks() {
  return request<{ books: WeeklyBookMeta[]; autoSendWeekly: boolean }>("/weekly-books");
}

export function setAutoSendWeekly(enabled: boolean) {
  return request<{ autoSendWeekly: boolean }>("/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ autoSendWeekly: enabled }),
  });
}

/** Pulls the filename out of `attachment; filename="Some Title.epub"`. */
function filenameFromDisposition(header: string | null): string | null {
  const match = header?.match(/filename="([^"]+)"/);
  return match ? match[1] : null;
}

/**
 * Fetches the EPUB with the session cookie attached and hands it to the browser
 * as a save. A plain link cannot carry the credentials, so this goes through
 * fetch and a temporary object URL.
 */
export async function downloadEpub(epubType: string, epubId: string, fallbackName: string) {
  const res = await fetch(`${API_BASE}/download/${epubType}/${epubId}`, {
    credentials: "include",
  });

  if (res.status === 401) {
    unauthorizedHandler?.();
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `Download failed: ${res.status}`);
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filenameFromDisposition(res.headers.get("Content-Disposition")) ?? fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function sendEpub(epubType: string, epubId: string) {
  return request<{ success: string }>("/send-epub", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ epub_type: epubType, epub_id: epubId }),
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
