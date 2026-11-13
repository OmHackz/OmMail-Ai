import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * End-to-end test of the Vercel function entry points.
 * The exported handlers use the Web `fetch(request)` signature that the
 * Vercel Node.js runtime supports.
 */

const ENV = {
  DEOMAIL_API_KEY: 'deo_test_key',
  AGNES_API_KEY: 'agnes_test_key',
  WEBHOOK_SECRET: 'test-webhook-secret-0123456789',
  ADMIN_SECRET: 'test-admin-secret-0123456789',
  STORAGE_PROVIDER: 'memory',
  AUTO_REPLY_MODE: 'draft',
  LOG_LEVEL: 'error',
};

let webhookModule: typeof import('../api/webhook');
let healthModule: typeof import('../api/health');
let statusModule: typeof import('../api/status');
let adminModule: typeof import('../api/admin/[...path]');

function mockFetch(): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('agnes-ai.com')) {
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          model: 'agnes-2.5-flash',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hello, happy to help.' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/v1/emails/')) {
      return new Response(
        JSON.stringify({
          success: true,
          email: {
            id: 'email-uuid-0001',
            from_addr: 'jane@example.com',
            to_addrs: ['support@omhackz.top'],
            subject: 'Question about your services',
            body_text: 'Hello, I have a question about your services.',
            headers: {},
            has_attachments: false,
            attachments: [],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/v1/send')) {
      return new Response(JSON.stringify({ success: true, email_id: 'e1', message_id: 'm1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ success: true, data: [], pagination: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  for (const [key, value] of Object.entries(ENV)) process.env[key] = value;
  vi.stubGlobal('fetch', mockFetch());

  const { resetApp } = await import('../src/server');
  resetApp();

  webhookModule = await import('../api/webhook');
  healthModule = await import('../api/health');
  statusModule = await import('../api/status');
  adminModule = await import('../api/admin/[...path]');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('vercel function entry points', () => {
  it('exposes a web standard handler', () => {
    expect(typeof webhookModule.default.fetch).toBe('function');
    expect(typeof healthModule.default.fetch).toBe('function');
    expect(typeof statusModule.default.fetch).toBe('function');
    expect(typeof adminModule.default.fetch).toBe('function');
  });

  it('answers the webhook request', async () => {
    const request = new Request('https://mailbot.omhackz.top/api/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': ENV.WEBHOOK_SECRET },
      body: JSON.stringify({
        event: 'fire.triggered',
        message_id: 'email-uuid-0001',
        from: 'Jane <jane@example.com>',
        subject: 'Question about your services',
        preview: 'Hello, I have a question about your services.',
        received_at: '2026-11-13T10:00:00.000Z',
        attachment_count: '0',
      }),
    });

    const response = await webhookModule.default.fetch(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; status: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe('draft_created');
  });

  it('answers the health probe', async () => {
    const response = await healthModule.default.fetch(new Request('https://mailbot.omhackz.top/api/health'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; status: string; storage: { provider: string } };
    expect(body.ok).toBe(true);
    expect(body.storage.provider).toBe('memory');
  });

  it('answers the public status endpoint without secrets', async () => {
    const response = await statusModule.default.fetch(new Request('https://mailbot.omhackz.top/api/status'));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(ENV.DEOMAIL_API_KEY);
    expect(text).not.toContain(ENV.AGNES_API_KEY);
    expect(text).not.toContain(ENV.ADMIN_SECRET);
    expect(text).not.toContain(ENV.WEBHOOK_SECRET);
  });

  it('protects the admin endpoints', async () => {
    const unauthorized = await adminModule.default.fetch(new Request('https://mailbot.omhackz.top/api/admin/stats'));
    expect(unauthorized.status).toBe(401);

    const authorized = await adminModule.default.fetch(
      new Request('https://mailbot.omhackz.top/api/admin/stats', {
        headers: { 'x-admin-secret': ENV.ADMIN_SECRET },
      }),
    );
    expect(authorized.status).toBe(200);
  });
});
