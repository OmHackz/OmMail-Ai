import { AppError } from '../lib/errors';
import type { SetOptions, Storage } from './storage';

/**
 * Upstash Redis over the REST API.
 *
 * Only the native fetch API is used — no SDK — which keeps the bundle small
 * and works on every Vercel runtime.
 */
export class RedisRestStorage implements Storage {
  readonly kind = 'redis' as const;

  private readonly url: string;
  private readonly token: string;
  private readonly prefix: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: {
    url: string;
    token: string;
    prefix?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  }) {
    this.url = options.url.replace(/\/+$/, '');
    this.token = options.token;
    this.prefix = options.prefix ?? 'ommail';
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  private key(key: string): string {
    return `${this.prefix}:${key}`;
  }

  private async command<T>(parts: unknown[]): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(parts),
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) {
        throw new AppError('Storage request failed', {
          category: 'storage',
          code: 'STORAGE_HTTP_ERROR',
          status: 503,
          retryable: response.status >= 500,
          details: { status: response.status },
        });
      }

      let payload: { result?: T; error?: string };
      try {
        payload = JSON.parse(text) as { result?: T; error?: string };
      } catch {
        throw new AppError('Storage returned an unexpected response', {
          category: 'storage',
          code: 'STORAGE_INVALID_RESPONSE',
          status: 503,
        });
      }

      if (payload.error) {
        throw new AppError('Storage command failed', {
          category: 'storage',
          code: 'STORAGE_COMMAND_ERROR',
          status: 503,
          details: { error: payload.error },
        });
      }
      return payload.result as T;
    } catch (error) {
      if (error instanceof AppError) throw error;
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new AppError('Storage request timed out', {
          category: 'timeout',
          code: 'STORAGE_TIMEOUT',
          status: 504,
          retryable: true,
        });
      }
      throw new AppError('Storage is unreachable', {
        category: 'storage',
        code: 'STORAGE_UNREACHABLE',
        status: 503,
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async get(key: string): Promise<string | null> {
    const result = await this.command<string | null>(['GET', this.key(key)]);
    return result ?? null;
  }

  async set(key: string, value: string, options: SetOptions = {}): Promise<boolean> {
    const parts: unknown[] = ['SET', this.key(key), value];
    if (options.ttlSeconds !== undefined) parts.push('EX', Math.max(1, Math.floor(options.ttlSeconds)));
    if (options.nx) parts.push('NX');
    const result = await this.command<string | null>(parts);
    return result === 'OK';
  }

  async del(key: string): Promise<void> {
    await this.command(['DEL', this.key(key)]);
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const fullKey = this.key(key);
    const value = await this.command<number>(['INCR', fullKey]);
    if (ttlSeconds !== undefined) {
      const ttl = await this.command<number>(['TTL', fullKey]);
      if (ttl < 0) {
        await this.command(['EXPIRE', fullKey, Math.max(1, Math.floor(ttlSeconds))]);
      }
    }
    return Number(value);
  }

  async decrement(key: string): Promise<number> {
    const value = await this.command<number>(['DECR', this.key(key)]);
    return Number(value);
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    await this.command(['EXPIRE', this.key(key), Math.max(1, Math.floor(ttlSeconds))]);
  }

  async lpush(key: string, value: string, maxLength = 200): Promise<void> {
    const fullKey = this.key(key);
    await this.command(['LPUSH', fullKey, value]);
    await this.command(['LTRIM', fullKey, 0, Math.max(0, maxLength - 1)]);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const result = await this.command<string[]>(['LRANGE', this.key(key), start, stop]);
    return Array.isArray(result) ? result : [];
  }

  async keys(prefix: string, limit = 100): Promise<string[]> {
    const pattern = `${this.key(prefix)}*`;
    const found: string[] = [];
    let cursor = '0';
    // SCAN is cursor based; loop a bounded number of times.
    for (let iteration = 0; iteration < 10 && found.length < limit; iteration += 1) {
      const result = await this.command<[string, string[]]>(['SCAN', cursor, 'MATCH', pattern, 'COUNT', String(limit)]);
      if (!Array.isArray(result)) break;
      cursor = result[0] ?? '0';
      const batch = Array.isArray(result[1]) ? result[1] : [];
      for (const key of batch) {
        found.push(key.startsWith(`${this.prefix}:`) ? key.slice(this.prefix.length + 1) : key);
        if (found.length >= limit) break;
      }
      if (cursor === '0') break;
    }
    return found;
  }

  async eval<T = unknown>(script: string, keys: string[], args: string[]): Promise<T> {
    return this.command<T>(['EVAL', script, keys.length, ...keys.map((k) => this.key(k)), ...args]);
  }

  async ping(): Promise<boolean> {
    const result = await this.command<string>(['PING']);
    return result === 'PONG';
  }

  async close(): Promise<void> {
    /* nothing to close */
  }
}
