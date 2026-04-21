import type { SQSHandler } from "aws-lambda";
import type { AwsEnv } from "./repositories/types.ts";
import { MAX_CONVERTED_ARTICLES } from "./repositories/types.ts";
import { DynamoFeedRepo, DynamoUserSubscriptionRepo, DynamoArticleRepo, DynamoS3EpubRepo } from "./repositories/aws.ts";
import { PostsService } from "./services/posts.service.ts";
import { ConversionService } from "./services/conversion.service.ts";
import { processArticleImages } from "./services/images.ts";
import { proxiedFetch } from "./http/proxied-fetch.ts";
import { createLogger } from "./logger.ts";
import { loadSecrets } from "./secrets.ts";
import type { FeedItem } from "./services/rss.ts";

const logger = createLogger("convert-article");

const env: AwsEnv = {
  DYNAMO_TABLE: process.env.DYNAMO_TABLE_NAME ?? "",
  S3_BUCKET: process.env.S3_BUCKET_NAME ?? "",
};

function defaultFetchHtml(url: string): Promise<string | null> {
  return proxiedFetch(url, { signal: AbortSignal.timeout(25000) })
    .then((resp) => (resp.ok ? resp.text() : null))
    .catch(() => null);
}

export const handler: SQSHandler = async (event) => {
  await loadSecrets();

  const feedRepo = new DynamoFeedRepo(env);
  const userSubRepo = new DynamoUserSubscriptionRepo(env);
  const posts = new PostsService(new DynamoArticleRepo(env), { fetch: defaultFetchHtml });
  const conversion = new ConversionService(new DynamoS3EpubRepo(env), { processArticleImages });

  for (const record of event.Records) {
    let feedItem: FeedItem;
    let feedId: string;
    let feedTitle: string;
    try {
      ({ feedItem, feedId, feedTitle } = JSON.parse(record.body) as {
        feedItem: FeedItem;
        feedId: string;
        feedTitle: string;
      });
    } catch {
      logger.error({ body: record.body }, "Failed to parse SQS message");
      continue;
    }

    try {
      const article = await posts.fetchAndSave(feedItem, feedId, feedTitle);
      if (!article) {
        logger.warn({ title: feedItem.title }, "No content extracted, skipping");
        continue;
      }

      const subscriberIds = await userSubRepo.getSubscriberUserIds(feedId);
      if (subscriberIds.length === 0) {
        logger.warn({ feedId }, "No subscribers for feed, skipping cache");
        continue;
      }

      const cacheKey = await conversion.convertAndCacheSubscriptionArticle(article, subscriberIds[0]);

      // Add to all other subscribers' cached articles too
      for (const userId of subscriberIds.slice(1)) {
        await conversion.addCachedArticleForUser(userId, article, cacheKey);
      }

      const feed = await feedRepo.get(feedId);
      if (feed) {
        const entry = { cacheKey, articleId: article.id, title: article.title, createdAt: article.savedAt };
        await feedRepo.put({
          ...feed,
          convertedArticles: [entry, ...feed.convertedArticles].slice(0, MAX_CONVERTED_ARTICLES),
        });
      }

      logger.info({ title: article.title, feedTitle }, "Article converted and linked to feed");
    } catch (err) {
      logger.error({ err, title: feedItem.title }, "Failed to convert article");
    }
  }
};
