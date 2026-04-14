import type { Env } from "../repositories/types.ts";
import type {
  ParseArticleMsg,
  ProcessImageMsg,
  AssembleEpubMsg,
  CheckFeedMsg,
} from "./types.ts";
import { handleParseArticle } from "./parse-article.ts";
import { handleProcessImage } from "./process-image.ts";
import { handleAssembleEpub } from "./assemble-epub.ts";
import { handleCheckFeed } from "./check-feed.ts";

type AnyMsg = ParseArticleMsg | ProcessImageMsg | AssembleEpubMsg | CheckFeedMsg;

/**
 * Top-level queue() handler. Dispatches by the queue name set in wrangler.toml
 * `[[queues.consumers]]`. Each message gets its own invocation (max_batch_size=1)
 * so the 10ms CPU budget is isolated.
 */
export async function handleQueueBatch(batch: MessageBatch<AnyMsg>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      switch (batch.queue) {
        case "blog-dl-parse-article":
          await handleParseArticle(message.body as ParseArticleMsg, env);
          break;
        case "blog-dl-process-image":
          await handleProcessImage(message.body as ProcessImageMsg, env);
          break;
        case "blog-dl-assemble-epub":
          await handleAssembleEpub(message.body as AssembleEpubMsg, env);
          break;
        case "blog-dl-check-feed":
          await handleCheckFeed(message.body as CheckFeedMsg, env);
          break;
        default:
          console.error(`[queue] unknown queue: ${batch.queue}`);
      }
      message.ack();
    } catch (err) {
      console.error(`[queue] ${batch.queue} message failed:`, err);
      message.retry();
    }
  }
}
