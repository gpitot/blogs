import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { AwsEnv } from "./repositories/types.ts";
import { DynamoFeedRepo } from "./repositories/aws.ts";
import { createLogger } from "./logger.ts";

const logger = createLogger("daily");

const env: AwsEnv = {
  DYNAMO_TABLE: process.env.DYNAMO_TABLE_NAME ?? "",
  S3_BUCKET: process.env.S3_BUCKET_NAME ?? "",
};

const sqsClient = new SQSClient({ region: process.env.AWS_REGION ?? "us-east-1" });

export const handler = async (): Promise<void> => {
  const feedRepo = new DynamoFeedRepo(env);
  const fetchPostsQueueUrl = process.env.FETCH_POSTS_QUEUE_URL ?? "";

  const feeds = await feedRepo.list();
  logger.info({ feedCount: feeds.length }, "Triggering fetch for all feeds");

  await Promise.all(
    feeds.map((feed) =>
      sqsClient.send(new SendMessageCommand({
        QueueUrl: fetchPostsQueueUrl,
        MessageBody: JSON.stringify({ feedId: feed.id }),
      })).catch((err) => logger.error({ err, feed: feed.title }, "Failed to enqueue feed")),
    ),
  );
};
