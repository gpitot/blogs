import type { AwsEnv } from "./repositories/types.ts";
import { DynamoSubscriptionRepo, DynamoArticleRepo, DynamoS3EpubRepo, DynamoUserRepo } from "./repositories/aws.ts";
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
  const subsRepo = new DynamoSubscriptionRepo(env);
  const articleRepo = new DynamoArticleRepo(env);
  const userRepo = new DynamoUserRepo(env);
  const epubRepo = new DynamoS3EpubRepo(env);
  const conversion = new ConversionService(epubRepo, { processArticleImages });

  const subs = await subsRepo.list();
  logger.info({ subCount: subs.length }, "Compiling weekly book from cached articles");

  const articles = (
    await Promise.all(
      subs.map(async (sub) => {
        const latest = sub.convertedArticles?.[0];
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
  const meta = await conversion.compileWeeklyBook(validArticles);
  if (!meta) {
    logger.error("compileWeeklyBook returned null");
    return;
  }

  const resendApiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.RESEND_FROM_ADDRESS ?? "";
  if (!resendApiKey) {
    logger.warn("RESEND_API_KEY not set, skipping email delivery");
    return;
  }

  const weeklyData = await conversion.getWeeklyBook(meta.weekKey);
  if (!weeklyData) {
    logger.error({ weekKey: meta.weekKey }, "Failed to retrieve weekly book data for emailing");
    return;
  }

  const userIds = [...new Set(subs.map((s) => s.userId).filter(Boolean))];
  const safeTitle = meta.title.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim() || "weekly-reading";

  for (const userId of userIds) {
    try {
      const user = await userRepo.getById(userId);
      if (!user) {
        logger.warn({ userId }, "User not found, skipping email");
        continue;
      }
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
