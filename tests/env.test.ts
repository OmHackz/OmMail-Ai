import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/lib/errors';
import { parseEnv, selfAddresses, selfDomains } from '../src/lib/env';

describe('environment configuration', () => {
  it('14. fails with a clear error when required variables are missing', () => {
    expect(() => parseEnv({})).toThrow(ConfigError);

    try {
      parseEnv({});
      throw new Error('parseEnv should have thrown');
    } catch (error) {
      const configError = error as ConfigError;
      expect(configError.category).toBe('config');
      expect(configError.details.missing).toEqual(
        expect.arrayContaining(['DEOMAIL_API_KEY', 'AGNES_API_KEY', 'WEBHOOK_SECRET', 'ADMIN_SECRET']),
      );
      // The error must never contain a secret value.
      expect(JSON.stringify(configError.details)).not.toContain('secret-value');
    }
  });

  it('14b. requires the Redis credentials when the redis provider is selected', () => {
    expect(() =>
      parseEnv({
        DEOMAIL_API_KEY: 'k',
        AGNES_API_KEY: 'k',
        WEBHOOK_SECRET: '0123456789abcdef',
        ADMIN_SECRET: '0123456789abcdef',
        STORAGE_PROVIDER: 'redis',
      }),
    ).toThrow(ConfigError);
  });

  it('14c. applies safe defaults', () => {
    const env = parseEnv({
      DEOMAIL_API_KEY: 'k',
      AGNES_API_KEY: 'k',
      WEBHOOK_SECRET: '0123456789abcdef',
      ADMIN_SECRET: '0123456789abcdef',
      STORAGE_PROVIDER: 'memory',
    });

    expect(env.AUTO_REPLY_MODE).toBe('draft');
    expect(env.AGNES_MODEL).toBe('agnes-2.5-flash');
    expect(env.AGNES_BASE_URL).toBe('https://apihub.agnes-ai.com/v1');
    expect(env.DEOMAIL_BASE_URL).toBe('https://api.deomail.com/v1');
    expect(env.DEOMAIL_SENDER).toBe('support@omhackz.top');
    expect(env.MAX_REPLIES_PER_DAY).toBe(25);
    expect(env.MAX_REPLIES_PER_SENDER_DAY).toBe(3);
    expect(env.REPLY_SIGNATURE).toContain('support@omhackz.top');
  });

  it('14d. rejects weak secrets', () => {
    expect(() =>
      parseEnv({
        DEOMAIL_API_KEY: 'k',
        AGNES_API_KEY: 'k',
        WEBHOOK_SECRET: 'short',
        ADMIN_SECRET: '0123456789abcdef',
        STORAGE_PROVIDER: 'memory',
      }),
    ).toThrow(ConfigError);
  });

  it('14e. parses the self identity lists', () => {
    const env = parseEnv({
      DEOMAIL_API_KEY: 'k',
      AGNES_API_KEY: 'k',
      WEBHOOK_SECRET: '0123456789abcdef',
      ADMIN_SECRET: '0123456789abcdef',
      STORAGE_PROVIDER: 'memory',
      SELF_DOMAINS: 'omhackz.top, example.org',
      SELF_ADDRESSES: 'support@omhackz.top',
    });

    expect(selfDomains(env)).toEqual(['omhackz.top', 'example.org']);
    expect(selfAddresses(env)).toEqual(['support@omhackz.top']);
  });
});
