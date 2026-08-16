import type { AwsEnv, ConvertedArticle, PendingArticle } from "./repositories/types.ts";
import { MAX_ARTICLES_PER_FEED, isAutoSendWeeklyEnabled } from "./repositories/types.ts";
import { DynamoFeedRepo, DynamoUserSubscriptionRepo, DynamoArticleRepo, DynamoS3EpubRepo, DynamoUserRepo, DynamoSentArticleRepo } from "./repositories/aws.ts";
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

/**
 * Picks the articles from one feed that belong in this user's next weekly book:
 * everything they have not already been sent, newest first, capped at
 * MAX_ARTICLES_PER_FEED, then returned oldest-first so the book reads in order.
 * Anything over the cap stays unsent and is picked up in a later week.
 */
export function selectUnsentArticles(
  convertedArticles: ConvertedArticle[] | undefined,
  alreadySent: ReadonlySet<string>,
): { selected: ConvertedArticle[]; deferred: number } {
  const unsent = (convertedArticles ?? []).filter((c) => !alreadySent.has(c.articleId));
  return {
    selected: unsent.slice(0, MAX_ARTICLES_PER_FEED).reverse(),
    deferred: Math.max(0, unsent.length - MAX_ARTICLES_PER_FEED),
  };
}

async function runWeeklyJob(): Promise<void> {
  const feedRepo = new DynamoFeedRepo(env);
  const userSubRepo = new DynamoUserSubscriptionRepo(env);
  const articleRepo = new DynamoArticleRepo(env);
  const userRepo = new DynamoUserRepo(env);
  const sentRepo = new DynamoSentArticleRepo(env);
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
    const alreadySent = new Set((await sentRepo.list(userId)).map((s) => s.articleId));

    // Articles whose cached body has aged out of DynamoDB. They can never be
    // delivered, so they are retired below rather than retried forever.
    const unavailable: string[] = [];

    const collected = (
      await Promise.all(
        userFeedIds.map(async (feedId) => {
          const feed = feedMap.get(feedId);
          if (!feed) return [];

          const { selected, deferred } = selectUnsentArticles(feed.convertedArticles, alreadySent);

          if (deferred > 0) {
            logger.info(
              { userId, feed: feed.title, deferred },
              "Feed exceeded per-feed cap, deferring remainder to a later week",
            );
          }
          if (selected.length === 0) {
            logger.debug({ userId, feed: feed.title }, "No new articles for feed this week");
            return [];
          }

          const fetched = await Promise.all(
            selected.map(async (entry) => {
              const article = await articleRepo.get(entry.articleId);
              if (!article) {
                logger.warn(
                  { feed: feed.title, articleId: entry.articleId },
                  "Cached article not found, skipping",
                );
                unavailable.push(entry.articleId);
                return null;
              }
              return article;
            }),
          );
          return fetched.filter((a): a is PendingArticle => a !== null);
        }),
      )
    ).flat();

    // Retire the expired ones regardless of what happens to this week's book,
    // so they stop consuming the per-feed cap.
    if (unavailable.length > 0) {
      await sentRepo.add(userId, unavailable);
      logger.info({ userId, count: unavailable.length }, "Retired expired articles");
    }

    // Two subscribed feeds can syndicate the same post; keep one copy.
    const articles = [...new Map(collected.map((a) => [a.id, a])).values()];

    if (articles.length === 0) {
      logger.info({ userId }, "No new articles for user, skipping");
      continue;
    }

    logger.info({ userId, articleCount: articles.length }, "Compiling weekly book for user");
    const meta = await conversion.compileWeeklyBook(articles, userId);
    if (!meta) continue;

    // The book exists now and stays on the website, so these articles are done
    // regardless of whether an email goes out. Retrying them next week would
    // only duplicate what the user can already read.
    await sentRepo.add(userId, articles.map((a) => a.id));

    const user = await userRepo.getById(userId);
    if (!user) {
      logger.warn({ userId }, "User not found, skipping email");
      continue;
    }

    if (!isAutoSendWeeklyEnabled(user)) {
      logger.info(
        { userId, weekKey: meta.weekKey },
        "Auto-send disabled for user, book compiled but not emailed",
      );
      continue;
    }

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
      // The book is already saved; the user can resend it from the website.
      logger.error({ err, userId }, "Failed to email weekly book to user");
    }
  }
}

export const handler = async (): Promise<void> => {
  await loadSecrets();
  await runWeeklyJob();
};
