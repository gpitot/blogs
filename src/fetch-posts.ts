import type { SQSHandler } from "aws-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { AwsEnv } from "./repositories/types.ts";
import { DynamoSubscriptionRepo } from "./repositories/aws.ts";
import { BlogsService } from "./services/blogs.service.ts";
import { detectFeedUrl, fetchAndParseFeed } from "./services/rss.ts";
import { createLogger } from "./logger.ts";
import { loadSecrets } from "./secrets.ts";

const logger = createLogger("fetch-posts");

const env: AwsEnv = {
  DYNAMO_TABLE: process.env.DYNAMO_TABLE_NAME ?? "",
  S3_BUCKET: process.env.S3_BUCKET_NAME ?? "",
};

const sqsClient = new SQSClient({ region: process.env.AWS_REGION ?? "us-east-1" });

export const handler: SQSHandler = async (event) => {
  await loadSecrets();

  const subsRepo = new DynamoSubscriptionRepo(env);
  const blogs = new BlogsService(subsRepo, { detectFeedUrl, fetchAndParseFeed });
  const convertQueueUrl = process.env.CONVERT_ARTICLE_QUEUE_URL ?? "";

  for (const record of event.Records) {
    let subscriptionId: string;
    let userId: string;
    try {
      ({ subscriptionId, userId } = JSON.parse(record.body) as { subscriptionId: string; userId: string });
    } catch {
      logger.error({ body: record.body }, "Failed to parse SQS message");
      continue;
    }

    const sub = await subsRepo.get(subscriptionId);
    if (!sub) {
      logger.warn({ subscriptionId }, "Subscription not found");
      continue;
    }

    try {
      const newItems = await blogs.checkForNewPosts(sub);
      logger.info({ sub: sub.title, newItems: newItems.length }, "Fetched new posts");

      for (const item of newItems) {
        await sqsClient.send(new SendMessageCommand({
          QueueUrl: convertQueueUrl,
          MessageBody: JSON.stringify({ feedItem: item, subId: sub.id, userId: sub.userId, subTitle: sub.title }),
        }));
      }
    } catch (err) {
      logger.error({ err, sub: sub.title }, "Failed to check for new posts");
    }
  }
};
