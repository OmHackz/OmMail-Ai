import { MemoryStorage } from './memory';
import { RedisRestStorage } from './redis';
import type { Storage, StorageFactoryOptions } from './storage';

/** Build the storage backend selected by `STORAGE_PROVIDER`. */
export function createStorage(options: StorageFactoryOptions): Storage {
  if (options.provider === 'memory') {
    return new MemoryStorage();
  }
  if (!options.url || !options.token) {
    throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for STORAGE_PROVIDER=redis');
  }
  return new RedisRestStorage({
    url: options.url,
    token: options.token,
    prefix: options.prefix,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  });
}
