import type { AwsEnv } from "./repositories/types.ts";
import { DynamoSubscriptionRepo, DynamoArticleRepo, DynamoS3EpubRepo } from "./repositories/aws.ts";
import { ConversionService } from "./services/conversion.service.ts";
import { processArticleImages } from "./services/images.ts";
import { createLogger } from "./logger.ts";
import { loadSecrets } from "./secrets.ts";

const logger = createLogger("weekly");

const env: AwsEnv = {
  DYNAMO_TABLE: process.env.DYNAMO_TABLE_NAME ?? "",
  S3_BUCKET: process.env.S3_BUCKET_NAME ?? "",
};

async function runWeeklyJob(): Promise<void> {
  const subsRepo = new DynamoSubscriptionRepo(env);
  const articleRepo = new DynamoArticleRepo(env);
  const conversion = new ConversionService(new DynamoS3EpubRepo(env), { processArticleImages });

  const subs = await subsRepo.list();
  logger.info({ subCount: subs.length }, "Compiling weekly book from cached articles");

  const articles = (
    await Promise.all(
      subs.map(async (sub) => {
        const latest = sub.convertedArticles[0];
        if (!latest) return null;
        const article = await articleRepo.get(latest.articleId);
        if (!article) {
          logger.warn({ sub: sub.title, articleId: latest.articleId }, "Cached article not found, skipping");
          return null;
        }
        return article;
      }),
    )
  ).filter(Boolean) as Awaited<ReturnType<typeof articleRepo.get>>[];

  const validArticles = articles.filter((a): a is NonNullable<typeof a> => a !== null);

  if (validArticles.length === 0) {
    logger.info("No cached articles found, skipping book generation");
    return;
  }

  logger.info({ articleCount: validArticles.length }, "Compiling weekly book");
  await conversion.compileWeeklyBook(validArticles);
}

export const handler = async (): Promise<void> => {
  await loadSecrets();
  await runWeeklyJob();
};
