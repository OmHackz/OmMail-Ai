import { App } from '../src/app';
import { AgnesClient } from '../src/ai/agnes';
import { DeoMailClient } from '../src/email/deomail';
import { MemoryStorage } from '../src/db/memory';
import { parseEnv } from '../src/lib/env';
import type { Env } from '../src/lib/env';
import { nullLogger } from '../src/lib/logger';

export const TEST_WEBHOOK_SECRET = 'test-webhook-secret-0123456789';
export const TEST_ADMIN_SECRET = 'test-admin-secret-0123456789';

/** Build a valid environment for tests. */
export function testEnv(overrides: Record<string, unknown> = {}): Env {
  return parseEnv({
    DEOMAIL_API_KEY: 'deo_test_key',
    DEOMAIL_SENDER: 'support@omhackz.top',
    WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    ADMIN_SECRET: TEST_ADMIN_SECRET,
    AGNES_API_KEY: 'agnes_test_key',
    AGNES_MODEL: 'agnes-2.5-flash',
    STORAGE_PROVIDER: 'memory',
    AUTO_REPLY_MODE: 'draft',
    MAX_REPLIES_PER_DAY: 25,
    MAX_REPLIES_PER_SENDER_DAY: 3,
    ...overrides,
  });
}

/** Canonical DeoMail Fire webhook payload (the template DeoMail generates). */
export function samplePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: 'fire.triggered',
    message_id: 'email-uuid-0001',
    from: 'Jane Customer <jane@example.com>',
    subject: 'Question about your services',
    preview:
      'Hi, I would like to know whether you take on small software projects. Could you tell me what that would look like? Thanks a lot!',
    received_at: '2026-11-13T10:00:00.000Z',
    attachment_count: '0',
    ...overrides,
  };
}

export interface HarnessOptions {
  env?: Record<string, unknown>;
  /** Return a Response for the Agnes chat completion request. */
  agnes?: (body: Record<string, unknown>, init?: RequestInit) => Response | Promise<Response>;
  /** Return a Response for DeoMail requests. */
  deomail?: (url: string, init?: RequestInit) => Response | Promise<Response>;
}

export interface Harness {
  app: App;
  env: Env;
  storage: MemoryStorage;
  calls: { agnes: Array<{ body: Record<string, unknown> }>; deomail: Array<{ url: string; body?: unknown }> };
  /** Build a webhook request and keep the mock DeoMail API in sync with it. */
  webhook(payload?: unknown, options?: { secret?: string | null; headers?: Record<string, string>; method?: string }): Request;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Create an application wired to mocked upstreams. */
export function createHarness(options: HarnessOptions = {}): Harness {
  const env = testEnv(options.env ?? {});
  const calls: Harness['calls'] = { agnes: [], deomail: [] };

  // Keeps the mocked DeoMail API consistent with the webhook payload that was
  // delivered (same subject, same sender, same body).
  let currentSubject = 'Question about your services';
  let currentFrom = 'jane@example.com';
  let currentBody =
    'Hi, I would like to know whether you take on small software projects. Could you tell me what that would look like? Thanks a lot!';

  const fetchImpl = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes('agnes-ai.com')) {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.agnes.push({ body });
      if (options.agnes) return options.agnes(body, init);
      return jsonResponse({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 1763000000,
        model: 'agnes-2.5-flash',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hi Jane,\n\nYes — we take on small software projects. Send a short description and we will come back to you with next steps.\n\nBest regards' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 42, total_tokens: 162 },
      });
    }

    if (url.includes('deomail.com')) {
      let body: unknown;
      if (init?.body) {
        try {
          body = JSON.parse(String(init.body));
        } catch {
          body = init.body;
        }
      }
      calls.deomail.push({ url, body });

      if (options.deomail) return options.deomail(url, init);

      if (url.includes('/v1/send')) {
        return jsonResponse({ success: true, email_id: 'sent-email-1', message_id: 'msg_abc123', fingerprint_id: 'DM-91897B' });
      }
      if (/\/v1\/emails\/[^/?]+$/.test(url)) {
        const id = decodeURIComponent(url.split('/').pop() ?? '');
        const payload = (options.env?.__emailPayload ?? null) as Record<string, unknown> | null;
        return jsonResponse({
          success: true,
          email: {
            id,
            from_addr: currentFrom,
            to_addrs: ['support@omhackz.top'],
            subject: currentSubject,
            body_text: currentBody,
            body_html: `<p>${currentBody}</p>`,
            headers: { from: currentFrom, to: 'support@omhackz.top' },
            received_at: '2026-11-13T10:00:00.000Z',
            has_attachments: false,
            attachments: [],
            ...(payload ?? {}),
          },
        });
      }
      if (url.includes('/v1/emails')) {
        return jsonResponse({ success: true, data: [], pagination: { page: 1, limit: 20, total: 0, total_pages: 0 } });
      }
      return jsonResponse({ success: true });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  const storage = new MemoryStorage();

  const deomail = new DeoMailClient({
    apiKey: env.DEOMAIL_API_KEY,
    baseUrl: env.DEOMAIL_BASE_URL,
    timeoutMs: 5000,
    maxRetries: 0,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  const agnes = new AgnesClient({
    apiKey: env.AGNES_API_KEY,
    baseUrl: env.AGNES_BASE_URL,
    model: env.AGNES_MODEL,
    temperature: env.AGNES_TEMPERATURE,
    maxTokens: env.AGNES_MAX_TOKENS,
    timeoutMs: env.AGNES_TIMEOUT_MS,
    maxRetries: env.AGNES_MAX_RETRIES,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleepImpl: async () => undefined,
  });

  const app = new App({ env, storage, deomail, agnes, logger: nullLogger });

  const harness: Harness = {
    app,
    env,
    storage,
    calls,
    webhook(payload?: unknown, options = {}) {
      const body = (payload ?? samplePayload()) as Record<string, unknown>;
      if (typeof body.subject === 'string') currentSubject = body.subject;
      if (typeof body.from === 'string') {
        const match = body.from.match(/<([^>]+)>/);
        currentFrom = (match?.[1] ?? body.from).toLowerCase();
      }
      if (typeof body.preview === 'string') currentBody = body.preview;
      return webhookRequest(body, options);
    },
  };

  return harness;
}

/** Build a webhook request with the shared secret. */
export function webhookRequest(
  payload: unknown,
  options: { secret?: string | null; headers?: Record<string, string>; method?: string } = {},
): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(options.headers ?? {}),
  };
  if (options.secret !== null) {
    headers['x-webhook-secret'] = options.secret ?? TEST_WEBHOOK_SECRET;
  }
  return new Request('https://mailbot.omhackz.top/api/webhook', {
    method: options.method ?? 'POST',
    headers,
    body: options.method && options.method !== 'POST' ? undefined : JSON.stringify(payload),
  });
}

/** Build an admin request. */
export function adminRequest(
  path: string,
  init: { method?: string; body?: unknown; secret?: string | null; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init.headers ?? {}),
  };
  if (init.secret !== null) {
    headers['x-admin-secret'] = init.secret ?? TEST_ADMIN_SECRET;
  }
  return new Request(`https://mailbot.omhackz.top/api/admin${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

export async function readJson<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
