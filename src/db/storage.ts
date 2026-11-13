/**
 * Storage abstraction.
 *
 * Production uses Upstash Redis over its REST API (serverless friendly, free
 * tier available). The in-memory implementation exists for local development
 * and tests only and is **not** durable across function instances.
 */

export interface SetOptions {
  ttlSeconds?: number;
  /** Only set when the key does not exist yet (atomic compare-and-set). */
  nx?: boolean;
}

export interface Storage {
  readonly kind: 'redis' | 'memory';

  get(key: string): Promise<string | null>;
  /** Returns true when the value was stored, false when NX blocked the write. */
  set(key: string, value: string, options?: SetOptions): Promise<boolean>;
  del(key: string): Promise<void>;
  incr(key: string, ttlSeconds?: number): Promise<number>;
  decrement(key: string): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<void>;
  lpush(key: string, value: string, maxLength?: number): Promise<void>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  keys(prefix: string, limit?: number): Promise<string[]>;
  /** Run a Lua script (Redis only). */
  eval<T = unknown>(script: string, keys: string[], args: string[]): Promise<T>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export interface StorageFactoryOptions {
  provider: 'redis' | 'memory';
  url?: string;
  token?: string;
  prefix?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}
