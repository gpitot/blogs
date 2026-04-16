import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { AwsEnv } from "./repositories/types.ts";
import { DynamoSubscriptionRepo } from "./repositories/aws.ts";
import { createLogger } from "./logger.ts";

const logger = createLogger("daily");

const env: AwsEnv = {
  DYNAMO_TABLE: process.env.DYNAMO_TABLE_NAME ?? "",
  S3_BUCKET: process.env.S3_BUCKET_NAME ?? "",
};

const sqsClient = new SQSClient({ region: process.env.AWS_REGION ?? "us-east-1" });

export const handler = async (): Promise<void> => {
  const subsRepo = new DynamoSubscriptionRepo(env);
  const fetchPostsQueueUrl = process.env.FETCH_POSTS_QUEUE_URL ?? "";

  const subs = await subsRepo.list();
  logger.info({ subCount: subs.length }, "Triggering fetch for all subscriptions");

  await Promise.all(
    subs.map((sub) =>
      sqsClient.send(new SendMessageCommand({
        QueueUrl: fetchPostsQueueUrl,
        MessageBody: JSON.stringify({ subscriptionId: sub.id }),
      })).catch((err) => logger.error({ err, sub: sub.title }, "Failed to enqueue subscription")),
    ),
  );
};
