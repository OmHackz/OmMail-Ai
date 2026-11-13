import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../src/db/memory';
import { RedisRestStorage } from '../src/db/redis';
import { Repository } from '../src/db/repositories';

/** Minimal in-memory simulation of the Upstash Redis REST API. */
function createRedisMock() {
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  const calls: Array<{ command: unknown[]; url: string }> = [];

  const expired = (key: string): boolean => {
    const entry = store.get(key);
    if (!entry) return true;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return true;
    }
    return false;
  };

  const execute = (command: unknown[]): unknown => {
    const [name, ...rest] = command as [string, ...(string | undefined)[]];
    const arg = (index: number): string => rest[index] ?? '';
    switch (name) {
      case 'GET': {
        if (expired(arg(0))) return null;
        return store.get(arg(0))?.value ?? null;
      }
      case 'SET': {
        const key = arg(0);
        const value = arg(1);
        let ttl: number | undefined;
        let nx = false;
        for (let i = 2; i < rest.length; i += 1) {
          if (arg(i) === 'EX') ttl = Number(arg(i + 1));
          if (arg(i) === 'NX') nx = true;
        }
        if (nx && !expired(key)) return null;
        store.set(key, { value, expiresAt: ttl ? Date.now() + ttl * 1000 : null });
        return 'OK';
      }
      case 'DEL':
        store.delete(arg(0));
        return 1;
      case 'INCR': {
        const current = Number(store.get(arg(0))?.value ?? '0');
        const next = (Number.isFinite(current) ? current : 0) + 1;
        store.set(arg(0), { value: String(next), expiresAt: store.get(arg(0))?.expiresAt ?? null });
        return next;
      }
      case 'DECR': {
        const current = Number(store.get(arg(0))?.value ?? '0');
        const next = Math.max(0, current - 1);
        store.set(arg(0), { value: String(next), expiresAt: store.get(arg(0))?.expiresAt ?? null });
        return next;
      }
      case 'TTL': {
        const entry = store.get(arg(0));
        if (!entry || entry.expiresAt === null) return -1;
        return Math.ceil((entry.expiresAt - Date.now()) / 1000);
      }
      case 'EXPIRE': {
        const entry = store.get(arg(0));
        if (!entry) return 0;
        entry.expiresAt = Date.now() + Number(arg(1)) * 1000;
        return 1;
      }
      case 'LPUSH': {
        const entry = store.get(arg(0));
        const list = entry ? (JSON.parse(entry.value) as string[]) : [];
        list.unshift(arg(1));
        store.set(arg(0), { value: JSON.stringify(list), expiresAt: entry?.expiresAt ?? null });
        return list.length;
      }
      case 'LTRIM': {
        const entry = store.get(arg(0));
        if (!entry) return 0;
        const list = JSON.parse(entry.value) as string[];
        store.set(arg(0), { value: JSON.stringify(list.slice(Number(arg(1)), Number(arg(2)) + 1)), expiresAt: entry.expiresAt });
        return 1;
      }
      case 'LRANGE': {
        const entry = store.get(arg(0));
        if (!entry) return [];
        const list = JSON.parse(entry.value) as string[];
        const start = Number(arg(1));
        const stop = Number(arg(2));
        return list.slice(start, stop < 0 ? list.length + stop : stop + 1);
      }
      case 'SCAN': {
        const pattern = arg(1);
        const prefix = pattern.replace(/\*$/, '');
        const keys = [...store.keys()].filter((key) => key.startsWith(prefix));
        return ['0', keys];
      }
      case 'PING':
        return 'PONG';
      default:
        throw new Error(`Unsupported command in mock: ${name}`);
    }
  };

  const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const url = String(input);
    const command = JSON.parse(String(init?.body)) as unknown[];
    calls.push({ command, url });
    const result = execute(command);
    return new Response(JSON.stringify({ result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  return { store, calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe('storage', () => {
  it('supports atomic compare-and-set in the memory store', async () => {
    const storage = new MemoryStorage();
    expect(await storage.set('key', 'a', { nx: true })).toBe(true);
    expect(await storage.set('key', 'b', { nx: true })).toBe(false);
    expect(await storage.get('key')).toBe('a');
    await storage.del('key');
    expect(await storage.get('key')).toBeNull();
  });

  it('supports atomic compare-and-set over the Upstash REST API', async () => {
    const mock = createRedisMock();
    const storage = new RedisRestStorage({
      url: 'https://example.upstash.io',
      token: 'token',
      prefix: 'ommail',
      fetchImpl: mock.fetchImpl,
    });

    expect(await storage.set('key', 'a', { nx: true })).toBe(true);
    expect(await storage.set('key', 'b', { nx: true })).toBe(false);
    expect(await storage.get('key')).toBe('a');

    // The prefix is applied to every command.
    expect(mock.calls[0]?.command[1]).toBe('ommail:key');
    expect(mock.calls[0]?.url).toBe('https://example.upstash.io');
  });

  it('increments counters and lists values', async () => {
    const mock = createRedisMock();
    const storage = new RedisRestStorage({
      url: 'https://example.upstash.io',
      token: 'token',
      prefix: 'ommail',
      fetchImpl: mock.fetchImpl,
    });

    expect(await storage.incr('counter', 60)).toBe(1);
    expect(await storage.incr('counter', 60)).toBe(2);
    expect(await storage.decrement('counter')).toBe(1);

    await storage.lpush('list', 'one', 10);
    await storage.lpush('list', 'two', 10);
    expect(await storage.lrange('list', 0, 5)).toEqual(['two', 'one']);
  });

  it('claims an event exactly once across repository instances', async () => {
    const mock = createRedisMock();
    const storage = new RedisRestStorage({
      url: 'https://example.upstash.io',
      token: 'token',
      prefix: 'ommail',
      fetchImpl: mock.fetchImpl,
    });

    const first = new Repository(storage);
    const second = new Repository(storage);

    const claimA = await first.claimEvent('email-1');
    expect(claimA.status).toBe('claimed');

    const claimB = await second.claimEvent('email-1');
    expect(claimB.status).toBe('in_progress');

    await first.completeEvent('email-1', { state: 'draft_created' });

    const claimC = await second.claimEvent('email-1');
    expect(claimC.status).toBe('duplicate');
  });

  it('counts usage statistics per day', async () => {
    const repository = new Repository(new MemoryStorage());
    await repository.incrementStat('processed');
    await repository.incrementStat('processed');
    await repository.incrementStat('replies_sent');

    const stats = await repository.getStats();
    expect(stats.processed).toBe(2);
    expect(stats.repliesSent).toBe(1);
  });

  it('reserves and releases reply quota', async () => {
    const repository = new Repository(new MemoryStorage());
    const first = await repository.reserveReplyQuota('a@example.com', {
      maxPerDay: 2,
      maxPerSenderPerDay: 1,
    });
    expect(first.allowed).toBe(true);

    const second = await repository.reserveReplyQuota('a@example.com', {
      maxPerDay: 2,
      maxPerSenderPerDay: 1,
    });
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe('sender_limit');

    const other = await repository.reserveReplyQuota('b@example.com', {
      maxPerDay: 2,
      maxPerSenderPerDay: 1,
    });
    expect(other.allowed).toBe(true);
  });

  it('limits replies per conversation', async () => {
    const repository = new Repository(new MemoryStorage());

    const first = await repository.claimConversationReply('jane|hello', 1);
    expect(first.allowed).toBe(true);
    expect(first.count).toBe(1);

    const second = await repository.claimConversationReply('jane|hello', 1);
    expect(second.allowed).toBe(false);
    expect(second.count).toBe(2);

    const other = await repository.claimConversationReply('jane|another topic', 1);
    expect(other.allowed).toBe(true);
  });
});
