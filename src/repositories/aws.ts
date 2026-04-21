import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type {
  AwsEnv,
  User,
  Feed,
  UserSubscription,
  PopularSubscription,
  PendingArticle,
  CacheEntry,
  WeeklyBookMeta,
  CachedArticleMeta,
  FeedRepo,
  UserSubscriptionRepo,
  UserRepo,
  ArticleRepo,
  EpubRepo,
} from "./types.ts";

// ---------------------------------------------------------------------------
// DynamoDB key constants
// ---------------------------------------------------------------------------

const INDEX_PK = "INDEX";
const POPULAR_SUBS_SK = "POPULAR_SUBS";
const WEEKLY_BOOKS_SK = "WEEKLY_BOOKS";
const CACHED_ARTICLES_SK = "CACHED_ARTICLES";

const GSI_SK = "sk-index";

const MAX_WEEKLY_BOOKS = 8;
const MAX_CACHED_ARTICLES = 20;
const PENDING_ARTICLE_TTL_SECS = 30 * 24 * 60 * 60; // 30 days
const EPUB_CACHE_TTL_SECS = 7 * 24 * 60 * 60; // 7 days
const WEEKLY_BOOK_TTL_SECS = 60 * 24 * 60 * 60; // 60 days

function nowPlusSecs(secs: number): number {
  return Math.floor(Date.now() / 1000) + secs;
}

// ---------------------------------------------------------------------------
// DynamoDB client helpers
// ---------------------------------------------------------------------------

function makeDocClient(env: AwsEnv) {
  const base = new DynamoDBClient({ region: process.env.AWS_REGION ?? "us-east-1" });
  return { doc: DynamoDBDocumentClient.from(base), table: env.DYNAMO_TABLE };
}

async function dbGet<T>(
  doc: DynamoDBDocumentClient,
  table: string,
  pk: string,
  sk: string,
): Promise<T | null> {
  const res = await doc.send(new GetCommand({ TableName: table, Key: { pk, sk } }));
  if (!res.Item?.data) return null;
  try {
    return JSON.parse(res.Item.data as string) as T;
  } catch {
    return null;
  }
}

async function dbPut(
  doc: DynamoDBDocumentClient,
  table: string,
  pk: string,
  sk: string,
  data: unknown,
  ttl?: number,
): Promise<void> {
  const item: Record<string, unknown> = { pk, sk, data: JSON.stringify(data) };
  if (ttl !== undefined) item.ttl = ttl;
  await doc.send(new PutCommand({ TableName: table, Item: item }));
}

// ---------------------------------------------------------------------------
// Feed repository
// ---------------------------------------------------------------------------

export class DynamoFeedRepo implements FeedRepo {
  private doc: DynamoDBDocumentClient;
  private table: string;

  constructor(env: AwsEnv) {
    const { doc, table } = makeDocClient(env);
    this.doc = doc;
    this.table = table;
  }

  async get(id: string): Promise<Feed | null> {
    return dbGet<Feed>(this.doc, this.table, `FEED#${id}`, "#ITEM");
  }

  async getByUrl(feedUrl: string): Promise<Feed | null> {
    const { feedUrlToId } = await import("../utils.ts");
    const id = await feedUrlToId(feedUrl);
    return this.get(id);
  }

  async put(feed: Feed): Promise<void> {
    await dbPut(this.doc, this.table, `FEED#${feed.id}`, "#ITEM", feed);
  }

  async list(): Promise<Feed[]> {
    const res = await this.doc.send(new ScanCommand({
      TableName: this.table,
      FilterExpression: "begins_with(pk, :prefix) AND sk = :sk",
      ExpressionAttributeValues: { ":prefix": "FEED#", ":sk": "#ITEM" },
    }));
    return (res.Items ?? [])
      .map((item) => { try { return JSON.parse(item.data as string) as Feed; } catch { return null; } })
      .filter(Boolean) as Feed[];
  }

  async getPopular(): Promise<PopularSubscription[]> {
    const list = await dbGet<PopularSubscription[]>(this.doc, this.table, INDEX_PK, POPULAR_SUBS_SK);
    return (list ?? []).filter((s) => s.subscriberCount > 0).sort((a, b) => b.subscriberCount - a.subscriberCount);
  }

  async incrementPopular(feedUrl: string, siteUrl: string, title: string): Promise<void> {
    const list = await dbGet<PopularSubscription[]>(this.doc, this.table, INDEX_PK, POPULAR_SUBS_SK) ?? [];
    const existing = list.find((s) => s.feedUrl === feedUrl);
    if (existing) {
      existing.subscriberCount++;
      existing.title = title;
      existing.siteUrl = siteUrl;
    } else {
      list.push({ feedUrl, siteUrl, title, subscriberCount: 1 });
    }
    await dbPut(this.doc, this.table, INDEX_PK, POPULAR_SUBS_SK, list);
  }

  async decrementPopular(feedUrl: string): Promise<void> {
    const list = await dbGet<PopularSubscription[]>(this.doc, this.table, INDEX_PK, POPULAR_SUBS_SK) ?? [];
    const existing = list.find((s) => s.feedUrl === feedUrl);
    if (existing) {
      existing.subscriberCount = Math.max(0, existing.subscriberCount - 1);
      await dbPut(this.doc, this.table, INDEX_PK, POPULAR_SUBS_SK, list);
    }
  }
}

// ---------------------------------------------------------------------------
// User subscription repository (join table)
// ---------------------------------------------------------------------------

export class DynamoUserSubscriptionRepo implements UserSubscriptionRepo {
  private doc: DynamoDBDocumentClient;
  private table: string;

  constructor(env: AwsEnv) {
    const { doc, table } = makeDocClient(env);
    this.doc = doc;
    this.table = table;
  }

  async listForUser(userId: string): Promise<UserSubscription[]> {
    const res = await this.doc.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": `USER_SUB#${userId}` },
    }));
    return (res.Items ?? [])
      .map((item) => { try { return JSON.parse(item.data as string) as UserSubscription; } catch { return null; } })
      .filter(Boolean) as UserSubscription[];
  }

  async subscribe(userId: string, feedId: string): Promise<void> {
    const sub: UserSubscription = { userId, feedId, addedAt: Date.now() };
    await dbPut(this.doc, this.table, `USER_SUB#${userId}`, `FEED#${feedId}`, sub);
  }

  async unsubscribe(userId: string, feedId: string): Promise<void> {
    await this.doc.send(new DeleteCommand({
      TableName: this.table,
      Key: { pk: `USER_SUB#${userId}`, sk: `FEED#${feedId}` },
    }));
  }

  async isSubscribed(userId: string, feedId: string): Promise<boolean> {
    const res = await this.doc.send(new GetCommand({
      TableName: this.table,
      Key: { pk: `USER_SUB#${userId}`, sk: `FEED#${feedId}` },
    }));
    return !!res.Item;
  }

  async getSubscriberUserIds(feedId: string): Promise<string[]> {
    const res = await this.doc.send(new QueryCommand({
      TableName: this.table,
      IndexName: GSI_SK,
      KeyConditionExpression: "sk = :sk",
      ExpressionAttributeValues: { ":sk": `FEED#${feedId}` },
    }));
    return (res.Items ?? [])
      .map((item) => (item.pk as string).replace("USER_SUB#", ""))
      .filter(Boolean);
  }
}

// ---------------------------------------------------------------------------
// User repository
// ---------------------------------------------------------------------------

export class DynamoUserRepo implements UserRepo {
  private doc: DynamoDBDocumentClient;
  private table: string;

  constructor(env: AwsEnv) {
    const { doc, table } = makeDocClient(env);
    this.doc = doc;
    this.table = table;
  }

  async create(user: User): Promise<void> {
    await Promise.all([
      dbPut(this.doc, this.table, `USER#${user.id}`, "#ITEM", user),
      dbPut(this.doc, this.table, `USER_BY_EMAIL#${user.email.toLowerCase()}`, "#ITEM", { userId: user.id }),
      dbPut(this.doc, this.table, `USER_BY_APIKEY#${user.apiKey}`, "#ITEM", { userId: user.id }),
    ]);
  }

  async getById(id: string): Promise<User | null> {
    return dbGet<User>(this.doc, this.table, `USER#${id}`, "#ITEM");
  }

  async getByEmail(email: string): Promise<User | null> {
    const ref = await dbGet<{ userId: string }>(this.doc, this.table, `USER_BY_EMAIL#${email.toLowerCase()}`, "#ITEM");
    if (!ref) return null;
    return dbGet<User>(this.doc, this.table, `USER#${ref.userId}`, "#ITEM");
  }

  async getByApiKey(apiKey: string): Promise<User | null> {
    const ref = await dbGet<{ userId: string }>(this.doc, this.table, `USER_BY_APIKEY#${apiKey}`, "#ITEM");
    if (!ref) return null;
    return dbGet<User>(this.doc, this.table, `USER#${ref.userId}`, "#ITEM");
  }
}

// ---------------------------------------------------------------------------
// Article repository
// ---------------------------------------------------------------------------

export class DynamoArticleRepo implements ArticleRepo {
  private doc: DynamoDBDocumentClient;
  private table: string;

  constructor(env: AwsEnv) {
    const { doc, table } = makeDocClient(env);
    this.doc = doc;
    this.table = table;
  }

  async get(id: string): Promise<PendingArticle | null> {
    return dbGet<PendingArticle>(this.doc, this.table, `ARTICLE#${id}`, "#ITEM");
  }

  async put(article: PendingArticle): Promise<void> {
    await dbPut(
      this.doc,
      this.table,
      `ARTICLE#${article.id}`,
      "#ITEM",
      article,
      nowPlusSecs(PENDING_ARTICLE_TTL_SECS),
    );
  }
}

// ---------------------------------------------------------------------------
// EPUB repository (metadata in DynamoDB, binary data in S3)
// ---------------------------------------------------------------------------

export class DynamoS3EpubRepo implements EpubRepo {
  private doc: DynamoDBDocumentClient;
  private table: string;
  private s3: S3Client;
  private bucket: string;

  constructor(env: AwsEnv) {
    const { doc, table } = makeDocClient(env);
    this.doc = doc;
    this.table = table;
    this.s3 = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });
    this.bucket = env.S3_BUCKET;
  }

  async getCachedMeta(cacheKey: string): Promise<CacheEntry | null> {
    const hex = cacheKey.replace("epub:", "");
    return dbGet<CacheEntry>(this.doc, this.table, `EPUB#${hex}`, "#ITEM");
  }

  async putCachedMeta(cacheKey: string, entry: CacheEntry): Promise<void> {
    const hex = cacheKey.replace("epub:", "");
    await dbPut(
      this.doc,
      this.table,
      `EPUB#${hex}`,
      "#ITEM",
      entry,
      nowPlusSecs(EPUB_CACHE_TTL_SECS),
    );
  }

  async putEpubData(kvKey: string, data: Uint8Array, _ttlSeconds: number): Promise<void> {
    const s3Key = this.kvKeyToS3Key(kvKey);
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: s3Key,
        Body: data,
        ContentType: "application/epub+zip",
      }),
    );
  }

  async getEpubData(kvKey: string): Promise<ArrayBuffer | null> {
    const s3Key = this.kvKeyToS3Key(kvKey);
    try {
      const res = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: s3Key }),
      );
      const bytes = await res.Body!.transformToByteArray();
      return bytes.buffer as ArrayBuffer;
    } catch {
      return null;
    }
  }

  async listWeeklyBooks(userId: string): Promise<WeeklyBookMeta[]> {
    return (
      (await dbGet<WeeklyBookMeta[]>(this.doc, this.table, INDEX_PK, `${WEEKLY_BOOKS_SK}#${userId}`)) ?? []
    );
  }

  async addWeeklyBook(userId: string, meta: WeeklyBookMeta, data: Uint8Array): Promise<void> {
    await this.putEpubData(meta.kvKey, data, WEEKLY_BOOK_TTL_SECS);
    const books = await this.listWeeklyBooks(userId);
    const updated = [meta, ...books.filter((b) => b.weekKey !== meta.weekKey)].slice(
      0,
      MAX_WEEKLY_BOOKS,
    );
    await dbPut(this.doc, this.table, INDEX_PK, `${WEEKLY_BOOKS_SK}#${userId}`, updated);
  }

  async getWeeklyBookData(
    userId: string,
    weekKey: string,
  ): Promise<{ meta: WeeklyBookMeta; buf: ArrayBuffer } | null> {
    const books = await this.listWeeklyBooks(userId);
    const meta = books.find((b) => b.weekKey === weekKey);
    if (!meta) return null;
    const buf = await this.getEpubData(meta.kvKey);
    if (!buf) return null;
    return { meta, buf };
  }

  async listCachedArticles(userId: string): Promise<CachedArticleMeta[]> {
    return (
      (await dbGet<CachedArticleMeta[]>(this.doc, this.table, INDEX_PK, `${CACHED_ARTICLES_SK}#${userId}`)) ??
      []
    );
  }

  async addCachedArticle(userId: string, meta: CachedArticleMeta): Promise<void> {
    const articles = await this.listCachedArticles(userId);
    const updated = [meta, ...articles.filter((a) => a.cacheKey !== meta.cacheKey)].slice(
      0,
      MAX_CACHED_ARTICLES,
    );
    await dbPut(this.doc, this.table, INDEX_PK, `${CACHED_ARTICLES_SK}#${userId}`, updated);
  }

  private kvKeyToS3Key(kvKey: string): string {
    if (kvKey.startsWith("epub-data:")) {
      return `epub/${kvKey.replace("epub-data:", "")}`;
    }
    if (kvKey.startsWith("weekly-book-data:")) {
      return `weekly/${kvKey.replace("weekly-book-data:", "")}`;
    }
    return kvKey;
  }
}
