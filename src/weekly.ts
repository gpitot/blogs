import type { AwsEnv, PendingArticle } from "./repositories/types.ts";
import { createServices } from "./index.ts";

// ---------------------------------------------------------------------------
// Environment — read once at Lambda cold start
// ---------------------------------------------------------------------------

const env: AwsEnv = {
  DYNAMO_TABLE: process.env.DYNAMO_TABLE_NAME ?? "",
  S3_BUCKET: process.env.S3_BUCKET_NAME ?? "",
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  RESEND_FROM_ADDRESS: process.env.RESEND_FROM_ADDRESS,
  EMAIL_ALLOWLIST: process.env.EMAIL_ALLOWLIST,
};

// ---------------------------------------------------------------------------
// Weekly job logic
// ---------------------------------------------------------------------------

async function runWeeklyJob(): Promise<void> {
  console.log("[weekly] Checking subscriptions and compiling book...");
  const { blogs, posts, conversion } = createServices(env);
  const subs = await blogs.listSubscriptions();

  const allArticles: PendingArticle[] = [];

  for (const sub of subs) {
    try {
      const newItems = await blogs.checkForNewPosts(sub);
      const saved: PendingArticle[] = [];

      for (const item of newItems) {
        try {
          const article = await posts.fetchAndSave(item, sub.id, sub.title);
          if (article) {
            saved.push(article);
            allArticles.push(article);
          }
        } catch (err) {
          console.error(`[weekly] Failed to save ${item.link}:`, err);
        }
      }

      if (saved.length > 0) {
        await blogs.updateRecentArticles(sub, saved);
      }

      console.log(`[weekly] "${sub.title}": ${saved.length} new articles saved.`);
    } catch (err) {
      console.error(`[weekly] Error checking "${sub.title}":`, err);
    }
  }

  if (allArticles.length === 0) {
    console.log("[weekly] No new articles this week, skipping book generation.");
    return;
  }

  console.log(`[weekly] Compiling ${allArticles.length} articles into book...`);
  await conversion.compileWeeklyBook(allArticles);
}

// ---------------------------------------------------------------------------
// Lambda EventBridge handler
// ---------------------------------------------------------------------------

export const handler = async (): Promise<void> => {
  await runWeeklyJob();
};
