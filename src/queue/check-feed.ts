import type { Env } from "../repositories/types.ts";
import type { CheckFeedMsg, ParseArticleMsg } from "./types.ts";
import { KvSubscriptionRepo } from "../repositories/kv.ts";
import { BlogsService } from "../services/blogs.service.ts";
import { detectFeedUrl, fetchAndParseFeed } from "../services/rss.ts";
import { MAX_RECENT_ARTICLES } from "../repositories/types.ts";
import { generateId } from "../utils.ts";

/**
 * check-feed consumer. One invocation = one subscription.
 * Fetches the RSS feed (I/O, no CPU cost), diffs against seen guids, then
 * enqueues a `parse-article` message per new item (weekly mode). CPU cost
 * is small: RSS parse + guid set diff.
 */
export async function handleCheckFeed(msg: CheckFeedMsg, env: Env): Promise<void> {
  const subs = new KvSubscriptionRepo(env.EPUB_CACHE);
  const blogs = new BlogsService(subs, { detectFeedUrl, fetchAndParseFeed });

  const sub = await subs.get(msg.subId);
  if (!sub) {
    console.log(`[check-feed] subscription ${msg.subId} missing, skipping.`);
    return;
  }

  let newItems: Awaited<ReturnType<typeof blogs.checkForNewPosts>>;
  try {
    newItems = await blogs.checkForNewPosts(sub);
  } catch (err) {
    console.error(`[check-feed] ${sub.title}: feed check failed:`, err);
    return;
  }

  if (newItems.length === 0) {
    console.log(`[check-feed] ${sub.title}: no new posts.`);
    return;
  }

  const recent: Array<{ id: string; title: string; savedAt: number }> = [];

  for (const item of newItems) {
    const jobId = generateId();
    const parseMsg: ParseArticleMsg = {
      jobId,
      url: item.link,
      mode: "weekly",
      weekKey: msg.weekKey,
      subId: sub.id,
      subTitle: sub.title,
      feedTitle: item.title,
      feedContent: item.content,
    };
    await env.Q_PARSE_ARTICLE.send(parseMsg);
    recent.push({ id: jobId, title: item.title, savedAt: Date.now() });
  }

  // Record the newly-queued articles as "recent" on the subscription so the UI shows them.
  void MAX_RECENT_ARTICLES;
  await blogs.updateRecentArticles(sub, recent);

  console.log(`[check-feed] ${sub.title}: queued ${recent.length} articles.`);
}
