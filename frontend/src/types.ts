export interface RecentArticle {
  id: string;
  title: string;
  createdAt: number;
}

export interface Subscription {
  id: string;
  feedUrl: string;
  siteUrl: string;
  title: string;
  addedAt: number;
  lastChecked: number | null;
  seenGuids: string[];
  recentArticles: RecentArticle[];
}

export interface WeeklyBookMeta {
  weekKey: string;
  kvKey: string;
  title: string;
  createdAt: number;
  articleCount: number;
  size: number;
}

export interface CachedArticleMeta {
  cacheKey: string;
  title: string;
  createdAt: number;
  size: number;
}
