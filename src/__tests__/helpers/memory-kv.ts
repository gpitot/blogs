/**
 * In-memory KVNamespace implementation for integration tests.
 * Supports string and ArrayBuffer values, TTL expiration, and JSON list operations.
 */
export class MemoryKV implements KVNamespace {
  private store = new Map<string, { value: string | ArrayBuffer; expiresAt?: number }>();

  async get(key: string, options?: any): Promise<any> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    if (options?.type === "arrayBuffer") return entry.value;
    if (typeof entry.value === "string") return entry.value;
    return null;
  }

  async put(key: string, value: string | ArrayBuffer | ReadableStream, options?: any): Promise<void> {
    const expiresAt = options?.expirationTtl
      ? Date.now() + options.expirationTtl * 1000
      : undefined;
    this.store.set(key, { value: value as string | ArrayBuffer, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(): Promise<any> {
    return { keys: Array.from(this.store.keys()).map((name) => ({ name })) };
  }

  async getWithMetadata(): Promise<any> {
    return { value: null, metadata: null };
  }
}
