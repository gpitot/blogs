import type { SQSHandler } from "aws-lambda";
import type { AwsEnv } from "./repositories/types.ts";
import { MAX_CONVERTED_ARTICLES } from "./repositories/types.ts";
import { DynamoSubscriptionRepo, DynamoArticleRepo, DynamoS3EpubRepo } from "./repositories/aws.ts";
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

  const subsRepo = new DynamoSubscriptionRepo(env);
  const posts = new PostsService(new DynamoArticleRepo(env), { fetch: defaultFetchHtml });
  const conversion = new ConversionService(new DynamoS3EpubRepo(env), { processArticleImages });

  for (const record of event.Records) {
    let feedItem: FeedItem;
    let subId: string;
    let subTitle: string;
    try {
      ({ feedItem, subId, subTitle } = JSON.parse(record.body) as {
        feedItem: FeedItem;
        subId: string;
        subTitle: string;
      });
    } catch {
      logger.error({ body: record.body }, "Failed to parse SQS message");
      continue;
    }

    try {
      const article = await posts.fetchAndSave(feedItem, subId, subTitle);
      if (!article) {
        logger.warn({ title: feedItem.title }, "No content extracted, skipping");
        continue;
      }

      const cacheKey = await conversion.convertAndCacheSubscriptionArticle(article);

      const sub = await subsRepo.get(subId);
      if (sub) {
        const entry = { cacheKey, articleId: article.id, title: article.title, createdAt: article.savedAt };
        await subsRepo.put({
          ...sub,
          convertedArticles: [entry, ...sub.convertedArticles].slice(0, MAX_CONVERTED_ARTICLES),
        });
      }

      logger.info({ title: article.title, subTitle }, "Article converted and linked to subscription");
    } catch (err) {
      logger.error({ err, title: feedItem.title }, "Failed to convert article");
    }
  }
};
