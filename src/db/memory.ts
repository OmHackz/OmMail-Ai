import type { SetOptions, Storage } from './storage';

/**
 * In-memory storage — development and test helper only.
 *
 * It is explicitly NOT safe for production: Vercel functions are stateless and
 * may run on different instances, so deduplication and rate limits would not be
 * shared. The application refuses to use it unless STORAGE_PROVIDER=memory.
 */
export class MemoryStorage implements Storage {
  readonly kind = 'memory' as const;

  private readonly values = new Map<string, { value: string; expiresAt: number | null }>();

  private expired(key: string): boolean {
    const entry = this.values.get(key);
    if (!entry) return true;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.values.delete(key);
      return true;
    }
    return false;
  }

  async get(key: string): Promise<string | null> {
    if (this.expired(key)) return null;
    return this.values.get(key)?.value ?? null;
  }

  async set(key: string, value: string, options: SetOptions = {}): Promise<boolean> {
    if (options.nx && !this.expired(key)) return false;
    this.values.set(key, {
      value,
      expiresAt: options.ttlSeconds ? Date.now() + options.ttlSeconds * 1000 : null,
    });
    return true;
  }

  async del(key: string): Promise<void> {
    this.values.delete(key);
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const current = Number((await this.get(key)) ?? '0');
    const next = Number.isFinite(current) ? current + 1 : 1;
    const existing = this.values.get(key);
    const expiresAt =
      ttlSeconds !== undefined
        ? (existing?.expiresAt ?? Date.now() + ttlSeconds * 1000)
        : (existing?.expiresAt ?? null);
    this.values.set(key, { value: String(next), expiresAt });
    return next;
  }

  async decrement(key: string): Promise<number> {
    const current = Number((await this.get(key)) ?? '0');
    const next = Math.max(0, (Number.isFinite(current) ? current : 0) - 1);
    this.values.set(key, { value: String(next), expiresAt: this.values.get(key)?.expiresAt ?? null });
    return next;
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    const entry = this.values.get(key);
    if (!entry) return;
    entry.expiresAt = Date.now() + ttlSeconds * 1000;
  }

  async lpush(key: string, value: string, maxLength = 200): Promise<void> {
    const list = this.values.get(key);
    const items = list ? JSON.parse(list.value) as string[] : [];
    items.unshift(value);
    const trimmed = items.slice(0, maxLength);
    this.values.set(key, { value: JSON.stringify(trimmed), expiresAt: list?.expiresAt ?? null });
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const entry = this.values.get(key);
    if (!entry) return [];
    const items = JSON.parse(entry.value) as string[];
    const end = stop < 0 ? items.length + stop : stop;
    return items.slice(start, end + 1);
  }

  async keys(prefix: string, limit = 100): Promise<string[]> {
    const found: string[] = [];
    for (const key of this.values.keys()) {
      if (key.startsWith(prefix)) {
        found.push(key);
        if (found.length >= limit) break;
      }
    }
    return found;
  }

  async eval<T = unknown>(script: string, keys: string[], args: string[]): Promise<T> {
    // The memory store does not execute Lua; the repository layer only relies
    // on EVAL for optional atomic scripts and always has a non-EVAL fallback.
    void script;
    void keys;
    void args;
    throw new Error('EVAL is not supported by MemoryStorage');
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.values.clear();
  }
}
