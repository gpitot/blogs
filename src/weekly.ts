import type { AwsEnv, PendingArticle } from "./repositories/types.ts";
import { createServices } from "./index.ts";
import { createLogger } from "./logger.ts";
import { loadSecrets } from "./secrets.ts";

const logger = createLogger("weekly");

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
  const { blogs, posts, conversion } = createServices(env);
  const subs = await blogs.listSubscriptions();
  logger.info({ subCount: subs.length }, "Checking subscriptions and compiling book");

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
          logger.warn({ err, link: item.link }, "Failed to save article");
        }
      }

      if (saved.length > 0) {
        await blogs.updateRecentArticles(sub, saved);
      }

      logger.info({ sub: sub.title, saved: saved.length }, "Subscription checked");
    } catch (err) {
      logger.error({ err, sub: sub.title }, "Error checking subscription");
    }
  }

  if (allArticles.length === 0) {
    logger.info("No new articles this week, skipping book generation");
    return;
  }

  logger.info({ articleCount: allArticles.length }, "Compiling weekly book");
  await conversion.compileWeeklyBook(allArticles);
}

// ---------------------------------------------------------------------------
// Lambda EventBridge handler
// ---------------------------------------------------------------------------

export const handler = async (): Promise<void> => {
  await loadSecrets();
  env.RESEND_API_KEY = process.env.RESEND_API_KEY;
  await runWeeklyJob();
};
