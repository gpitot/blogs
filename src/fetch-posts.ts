import type { SQSHandler } from "aws-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { AwsEnv } from "./repositories/types.ts";
import { DynamoFeedRepo, DynamoUserSubscriptionRepo } from "./repositories/aws.ts";
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

  const feedRepo = new DynamoFeedRepo(env);
  const userSubRepo = new DynamoUserSubscriptionRepo(env);
  const blogs = new BlogsService(feedRepo, userSubRepo, { detectFeedUrl, fetchAndParseFeed });
  const convertQueueUrl = process.env.CONVERT_ARTICLE_QUEUE_URL ?? "";

  for (const record of event.Records) {
    let feedId: string;
    try {
      ({ feedId } = JSON.parse(record.body) as { feedId: string });
    } catch {
      logger.error({ body: record.body }, "Failed to parse SQS message");
      continue;
    }

    const feed = await feedRepo.get(feedId);
    if (!feed) {
      logger.warn({ feedId }, "Feed not found");
      continue;
    }

    try {
      const newItems = await blogs.checkForNewPosts(feed);
      logger.info({ feed: feed.title, newItems: newItems.length }, "Fetched new posts");

      for (const item of newItems) {
        await sqsClient.send(new SendMessageCommand({
          QueueUrl: convertQueueUrl,
          MessageBody: JSON.stringify({ feedItem: item, feedId: feed.id, feedTitle: feed.title }),
        }));
      }
    } catch (err) {
      logger.error({ err, feed: feed.title }, "Failed to check for new posts");
    }
  }
};
