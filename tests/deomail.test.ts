import { describe, expect, it } from 'vitest';
import { DeoMailClient } from '../src/email/deomail';
import { createHarness, readJson, samplePayload } from './fixtures';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('DeoMail integration', () => {
  it('9. sends the reply through the DeoMail REST API', async () => {
    const harness = createHarness({ env: { AUTO_REPLY_MODE: 'automatic' } });
    const response = await harness.app.handleWebhook(harness.webhook(samplePayload()));

    expect((await readJson<{ status: string }>(response)).status).toBe('sent');

    const sends = harness.calls.deomail.filter((call) => call.url.includes('/v1/send'));
    expect(sends).toHaveLength(1);

    const payload = sends[0]?.body as {
      from: string;
      to: string[];
      subject: string;
      text: string;
      html: string;
    };
    expect(payload.from).toBe('support@omhackz.top');
    expect(payload.to).toEqual(['jane@example.com']);
    expect(payload.subject).toBe('Re: Question about your services');
    expect(payload.text).toContain('Best regards');
    expect(payload.html).toContain('<p>');
  });

  it('9b. never sends the same email twice', async () => {
    const harness = createHarness({ env: { AUTO_REPLY_MODE: 'automatic' } });
    await harness.app.handleWebhook(harness.webhook(samplePayload()));
    await harness.app.handleWebhook(harness.webhook(samplePayload()));

    const sends = harness.calls.deomail.filter((call) => call.url.includes('/v1/send'));
    expect(sends).toHaveLength(1);
  });

  it('11. records a DeoMail failure and does not resend blindly', async () => {
    let sendAttempts = 0;
    const harness = createHarness({
      env: { AUTO_REPLY_MODE: 'automatic' },
      deomail: (url) => {
        if (url.includes('/v1/send')) {
          sendAttempts += 1;
          return jsonResponse({ error: 'Internal error', code: 'INTERNAL_ERROR' }, 500);
        }
        return jsonResponse({ success: true, email: { id: 'email-uuid-0001', body_text: 'Hello' } });
      },
    });

    const response = await harness.app.handleWebhook(harness.webhook(samplePayload()));
    const body = await readJson<{ ok: boolean; status: string; error?: string }>(response);

    expect(response.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.status).toBe('send_uncertain');
    expect(sendAttempts).toBe(1);

    const drafts = await harness.app.repository.listDrafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.status).toBe('failed');
  });

  it('11b. maps a DeoMail authentication failure', async () => {
    const client = new DeoMailClient({
      apiKey: 'bad',
      baseUrl: 'https://api.deomail.com/v1',
      timeoutMs: 5000,
      maxRetries: 0,
      fetchImpl: (async () => jsonResponse({ error: 'Invalid API key', code: 'INVALID_KEY' }, 401)) as unknown as typeof fetch,
    });

    await expect(
      client.sendEmail({ from: 'support@omhackz.top', to: ['a@example.com'], subject: 'Hi', text: 'Hi' }),
    ).rejects.toMatchObject({ category: 'auth' });
  });

  it('11c. treats a logical error delivered with HTTP 200 as a failure', async () => {
    const client = new DeoMailClient({
      apiKey: 'key',
      baseUrl: 'https://api.deomail.com/v1',
      timeoutMs: 5000,
      maxRetries: 0,
      fetchImpl: (async () => jsonResponse({ error: 'Sender not authorized', code: 'SENDER_NOT_AUTHORIZED' })) as unknown as typeof fetch,
    });

    await expect(
      client.sendEmail({ from: 'support@omhackz.top', to: ['a@example.com'], subject: 'Hi', text: 'Hi' }),
    ).rejects.toMatchObject({ category: 'blocked', code: 'SENDER_NOT_AUTHORIZED' });
  });

  it('11d. does not retry a send when the outcome is unknown', async () => {
    let attempts = 0;
    const client = new DeoMailClient({
      apiKey: 'key',
      baseUrl: 'https://api.deomail.com/v1',
      timeoutMs: 5000,
      maxRetries: 3,
      fetchImpl: (async () => {
        attempts += 1;
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        throw error;
      }) as unknown as typeof fetch,
    });

    await expect(
      client.sendEmail({ from: 'support@omhackz.top', to: ['a@example.com'], subject: 'Hi', text: 'Hi' }),
    ).rejects.toMatchObject({ deliveryUnknown: true, code: 'DEOMAIL_SEND_TIMEOUT' });
    expect(attempts).toBe(1);
  });

  it('11e. retries a rate limited send', async () => {
    let attempts = 0;
    const client = new DeoMailClient({
      apiKey: 'key',
      baseUrl: 'https://api.deomail.com/v1',
      timeoutMs: 5000,
      maxRetries: 2,
      sleepImpl: async () => undefined,
      fetchImpl: (async () => {
        attempts += 1;
        if (attempts < 2) return jsonResponse({ error: 'Too many requests', code: 'RATE_LIMITED' }, 429);
        return jsonResponse({ success: true, email_id: 'e1', message_id: 'm1' });
      }) as unknown as typeof fetch,
    });

    const result = await client.sendEmail({ from: 'support@omhackz.top', to: ['a@example.com'], subject: 'Hi', text: 'Hi' });
    expect(result.success).toBe(true);
    expect(attempts).toBe(2);
  });

  it('reads an email with the documented GET /emails/:id endpoint', async () => {
    const seen: string[] = [];
    const client = new DeoMailClient({
      apiKey: 'key',
      baseUrl: 'https://api.deomail.com/v1',
      timeoutMs: 5000,
      maxRetries: 0,
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        seen.push(String(input));
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers['X-API-Key']).toBe('key');
        return jsonResponse({
          success: true,
          email: {
            id: 'abc',
            from_addr: 'jane@example.com',
            to_addrs: ['support@omhackz.top'],
            subject: 'Hello',
            body_text: 'Full body',
            body_html: '<p>Full body</p>',
            has_attachments: false,
            attachments: [],
          },
        });
      }) as unknown as typeof fetch,
    });

    const email = await client.getEmail('abc');
    expect(seen[0]).toBe('https://api.deomail.com/v1/emails/abc');
    expect(email?.bodyText).toBe('Full body');
    expect(email?.from).toBe('jane@example.com');
  });

  it('lists emails with pagination', async () => {
    const client = new DeoMailClient({
      apiKey: 'key',
      baseUrl: 'https://api.deomail.com/v1',
      timeoutMs: 5000,
      maxRetries: 0,
      fetchImpl: (async () =>
        jsonResponse({
          success: true,
          data: [{ id: '1', from_addr: 'a@example.com', subject: 'Hi', to_addrs: ['support@omhackz.top'] }],
          pagination: { page: 1, limit: 20, total: 1, total_pages: 1 },
        })) as unknown as typeof fetch,
    });

    const result = await client.listEmails({ limit: 5, folder: 'inbox' });
    expect(result.emails).toHaveLength(1);
    expect(result.pagination.total).toBe(1);
  });

  it('reports the connection state', async () => {
    const client = new DeoMailClient({
      apiKey: 'key',
      baseUrl: 'https://api.deomail.com/v1',
      timeoutMs: 5000,
      maxRetries: 0,
      fetchImpl: (async () => jsonResponse({ success: true, data: [], pagination: {} })) as unknown as typeof fetch,
    });

    const status = await client.checkConnection();
    expect(status.ok).toBe(true);
  });
});
