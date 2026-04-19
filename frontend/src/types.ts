export interface ConvertedArticle {
  cacheKey: string;
  articleId: string;
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
  convertedArticles: ConvertedArticle[];
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
