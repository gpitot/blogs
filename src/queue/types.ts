/**
 * Queue message payloads. Each message type corresponds to exactly one queue.
 * Keep payloads small (<128KB) and self-contained.
 */

export interface ParseArticleMsg {
  jobId: string;
  url: string;
  /** "single" = POST /convert pipeline, "weekly" = part of a weekly compilation */
  mode: "single" | "weekly";
  /** For weekly mode */
  weekKey?: string;
  subId?: string;
  subTitle?: string;
  /** For single mode, used to send email after assembly */
  emailTo?: string | null;
  /** Pre-fetched title from RSS feed (fallback if Readability fails) */
  feedTitle?: string;
  /** Pre-fetched feed content (skip HTML fetch + Readability if present and long enough) */
  feedContent?: string;
}

export interface ProcessImageMsg {
  jobId: string;
  idx: number; // 0-based index matching ArticleMeta.imageUrls[idx]
  url: string; // absolute image URL
}

export interface AssembleEpubMsg {
  /** "single" assembles one article epub and caches it */
  kind: "single" | "weekly";
  jobId?: string; // single: the article jobId
  weekKey?: string; // weekly: the ISO week bucket
  emailTo?: string | null;
}

export interface CheckFeedMsg {
  subId: string;
  weekKey: string;
}
