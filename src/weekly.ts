import type { AwsEnv, PendingArticle } from "./repositories/types.ts";
import { DynamoFeedRepo, DynamoUserSubscriptionRepo, DynamoArticleRepo, DynamoS3EpubRepo, DynamoUserRepo } from "./repositories/aws.ts";
import { ConversionService } from "./services/conversion.service.ts";
import { sendEpubEmail } from "./services/email.service.ts";
import { processArticleImages } from "./services/images.ts";
import { createLogger } from "./logger.ts";
import { loadSecrets } from "./secrets.ts";

const logger = createLogger("weekly");

const env: AwsEnv = {
  DYNAMO_TABLE: process.env.DYNAMO_TABLE_NAME ?? "",
  S3_BUCKET: process.env.S3_BUCKET_NAME ?? "",
};

async function runWeeklyJob(): Promise<void> {
  const feedRepo = new DynamoFeedRepo(env);
  const userSubRepo = new DynamoUserSubscriptionRepo(env);
  const articleRepo = new DynamoArticleRepo(env);
  const userRepo = new DynamoUserRepo(env);
  const epubRepo = new DynamoS3EpubRepo(env);
  const conversion = new ConversionService(epubRepo, { processArticleImages });

  const feeds = await feedRepo.list();
  logger.info({ feedCount: feeds.length }, "Starting weekly book compilation");

  // Build a set of all user IDs that have subscriptions
  const allUserIds = new Set<string>();
  const feedsByUser = new Map<string, string[]>();

  for (const feed of feeds) {
    const subscriberIds = await userSubRepo.getSubscriberUserIds(feed.id);
    for (const userId of subscriberIds) {
      allUserIds.add(userId);
      const list = feedsByUser.get(userId) ?? [];
      list.push(feed.id);
      feedsByUser.set(userId, list);
    }
  }

  const feedMap = new Map(feeds.map((f) => [f.id, f]));
  const resendApiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.RESEND_FROM_ADDRESS ?? "";

  for (const userId of allUserIds) {
    const userFeedIds = feedsByUser.get(userId) ?? [];
    const articles = (
      await Promise.all(
        userFeedIds.map(async (feedId) => {
          const feed = feedMap.get(feedId);
          if (!feed) return null;
          const latest = feed.convertedArticles?.[0];
          if (!latest) return null;
          const article = await articleRepo.get(latest.articleId);
          if (!article) {
            logger.warn({ feed: feed.title, articleId: latest.articleId }, "Cached article not found, skipping");
            return null;
          }
          return article;
        }),
      )
    ).filter((a): a is PendingArticle => a !== null);

    if (articles.length === 0) {
      logger.info({ userId }, "No articles for user, skipping");
      continue;
    }

    logger.info({ userId, articleCount: articles.length }, "Compiling weekly book for user");
    const meta = await conversion.compileWeeklyBook(articles, userId);
    if (!meta) continue;

    if (!resendApiKey) {
      logger.warn("RESEND_API_KEY not set, skipping email delivery");
      continue;
    }

    const weeklyData = await conversion.getWeeklyBook(userId, meta.weekKey);
    if (!weeklyData) {
      logger.error({ weekKey: meta.weekKey, userId }, "Failed to retrieve weekly book data for emailing");
      continue;
    }

    try {
      const user = await userRepo.getById(userId);
      if (!user) {
        logger.warn({ userId }, "User not found, skipping email");
        continue;
      }
      const safeTitle = meta.title.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim() || "weekly-reading";
      await sendEpubEmail({
        apiKey: resendApiKey,
        fromAddress,
        to: user.email,
        title: meta.title,
        filename: `${safeTitle}.epub`,
        epubBytes: new Uint8Array(weeklyData.buf),
      });
      logger.info({ email: user.email, weekKey: meta.weekKey }, "Weekly book emailed");
    } catch (err) {
      logger.error({ err, userId }, "Failed to email weekly book to user");
    }
  }
}

export const handler = async (): Promise<void> => {
  await loadSecrets();
  await runWeeklyJob();
};
