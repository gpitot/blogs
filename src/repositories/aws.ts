import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
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
  Subscription,
  PopularSubscription,
  PendingArticle,
  CacheEntry,
  WeeklyBookMeta,
  CachedArticleMeta,
  UserRepo,
  SubscriptionRepo,
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
// Subscription repository
// ---------------------------------------------------------------------------

const GSI_USER_ID = "userId-index";

export class DynamoSubscriptionRepo implements SubscriptionRepo {
  private doc: DynamoDBDocumentClient;
  private table: string;

  constructor(env: AwsEnv) {
    const { doc, table } = makeDocClient(env);
    this.doc = doc;
    this.table = table;
  }

  async list(): Promise<Subscription[]> {
    const res = await this.doc.send(new ScanCommand({
      TableName: this.table,
      IndexName: GSI_USER_ID,
      FilterExpression: "begins_with(pk, :prefix)",
      ExpressionAttributeValues: { ":prefix": "SUB#" },
    }));
    return (res.Items ?? [])
      .map((item) => { try { return JSON.parse(item.data as string) as Subscription; } catch { return null; } })
      .filter(Boolean) as Subscription[];
  }

  async listForUser(userId: string): Promise<Subscription[]> {
    const res = await this.doc.send(new QueryCommand({
      TableName: this.table,
      IndexName: GSI_USER_ID,
      KeyConditionExpression: "userId = :uid AND begins_with(pk, :prefix)",
      ExpressionAttributeValues: { ":uid": userId, ":prefix": "SUB#" },
    }));
    return (res.Items ?? [])
      .map((item) => { try { return JSON.parse(item.data as string) as Subscription; } catch { return null; } })
      .filter(Boolean) as Subscription[];
  }

  async get(id: string): Promise<Subscription | null> {
    return dbGet<Subscription>(this.doc, this.table, `SUB#${id}`, "#ITEM");
  }

  async put(sub: Subscription): Promise<void> {
    const item: Record<string, unknown> = {
      pk: `SUB#${sub.id}`,
      sk: "#ITEM",
      data: JSON.stringify(sub),
      userId: sub.userId,
    };
    await this.doc.send(new PutCommand({ TableName: this.table, Item: item }));
  }

  async delete(id: string): Promise<void> {
    const { DeleteCommand } = await import("@aws-sdk/lib-dynamodb");
    await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { pk: `SUB#${id}`, sk: "#ITEM" } }));
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
    // kvKey format: "epub-data:{hex}" or "weekly-book-data:{weekKey}"
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
    // Store binary in S3
    await this.putEpubData(meta.kvKey, data, WEEKLY_BOOK_TTL_SECS);

    // Update index in DynamoDB
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

  // Map existing kvKey naming conventions to S3 keys
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
