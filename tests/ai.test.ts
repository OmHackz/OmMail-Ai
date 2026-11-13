import { describe, expect, it } from 'vitest';
import { AgnesClient } from '../src/ai/agnes';
import { AppError } from '../src/lib/errors';
import { createHarness, readJson, samplePayload } from './fixtures';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Agnes AI integration', () => {
  it('8. generates a reply through the OpenAI compatible endpoint', async () => {
    const harness = createHarness();
    await harness.app.handleWebhook(harness.webhook(samplePayload()));

    expect(harness.calls.agnes).toHaveLength(1);
    const request = harness.calls.agnes[0]?.body as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      stream: boolean;
    };

    expect(request.model).toBe('agnes-2.5-flash');
    expect(request.stream).toBe(false);
    expect(request.messages[0]?.role).toBe('system');
    expect(request.messages[0]?.content).toContain('email support assistant for OmHackz');
    expect(request.messages[1]?.role).toBe('user');
    expect(request.messages[1]?.content).toContain('<customer_email>');
    expect(request.messages[1]?.content).toContain('Jane Customer');

    const drafts = await harness.app.repository.listDrafts();
    expect(drafts[0]?.text).toContain('we take on small software projects');
  });

  it('8b. sends the Authorization header and the documented request shape', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      seen.push({ url: String(input), init });
      return jsonResponse({
        id: 'chatcmpl-1',
        model: 'agnes-2.5-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello there' }, finish_reason: 'stop' }],
      });
    };

    const client = new AgnesClient({
      apiKey: 'agnes_test_key',
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      model: 'agnes-2.5-flash',
      temperature: 0.5,
      maxTokens: 500,
      timeoutMs: 5000,
      maxRetries: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.chat([{ role: 'user', content: 'Hello' }]);
    expect(result.content).toBe('Hello there');

    const headers = seen[0]?.init?.headers as Record<string, string>;
    expect(seen[0]?.url).toBe('https://apihub.agnes-ai.com/v1/chat/completions');
    expect(headers.Authorization).toBe('Bearer agnes_test_key');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('10. handles an Agnes timeout without sending anything', async () => {
    const hangingFetch = (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });

    const harness = createHarness({
      env: { AGNES_TIMEOUT_MS: 1000, AGNES_MAX_RETRIES: 0, AUTO_REPLY_MODE: 'automatic' },
      agnes: (_body, init) => hangingFetch('https://apihub.agnes-ai.com/v1/chat/completions', init),
    });

    const response = await harness.app.handleWebhook(harness.webhook(samplePayload()));
    const body = await readJson<{ ok: boolean; status: string; error?: string }>(response);

    expect(response.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.status).toBe('failed');
    expect(body.error).toBe('AGNES_TIMEOUT');

    const sends = harness.calls.deomail.filter((call) => call.url.includes('/v1/send'));
    expect(sends).toHaveLength(0);
    expect(await harness.app.repository.listDrafts()).toHaveLength(0);
  });

  it('10b. maps an Agnes authentication failure', async () => {
    const client = new AgnesClient({
      apiKey: 'bad-key',
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      model: 'agnes-2.5-flash',
      temperature: 0.5,
      maxTokens: 100,
      timeoutMs: 5000,
      maxRetries: 0,
      fetchImpl: (async () =>
        jsonResponse({ error: { message: 'Token not provided', code: '', type: 'AgnesAI_error' } }, 401)) as unknown as typeof fetch,
    });

    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      category: 'auth',
      code: 'AGNES_AUTH_FAILED',
    });
  });

  it('10c. maps an exhausted Agnes quota', async () => {
    const client = new AgnesClient({
      apiKey: 'key',
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      model: 'agnes-2.5-flash',
      temperature: 0.5,
      maxTokens: 100,
      timeoutMs: 5000,
      maxRetries: 0,
      fetchImpl: (async () => jsonResponse({ error: { message: 'insufficient balance' } }, 402)) as unknown as typeof fetch,
    });

    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      category: 'rate_limit',
      code: 'AGNES_QUOTA_EXCEEDED',
    });
  });

  it('10d. rejects an unexpected Agnes response shape', async () => {
    const client = new AgnesClient({
      apiKey: 'key',
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      model: 'agnes-2.5-flash',
      temperature: 0.5,
      maxTokens: 100,
      timeoutMs: 5000,
      maxRetries: 0,
      fetchImpl: (async () => jsonResponse({ unexpected: true })) as unknown as typeof fetch,
    });

    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(AppError);
  });

  it('10e. retries transient upstream failures a bounded number of times', async () => {
    let attempts = 0;
    const client = new AgnesClient({
      apiKey: 'key',
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      model: 'agnes-2.5-flash',
      temperature: 0.5,
      maxTokens: 100,
      timeoutMs: 5000,
      maxRetries: 2,
      sleepImpl: async () => undefined,
      fetchImpl: (async () => {
        attempts += 1;
        if (attempts < 3) return jsonResponse({ error: { message: 'temporarily unavailable' } }, 503);
        return jsonResponse({ choices: [{ index: 0, message: { role: 'assistant', content: 'Recovered' } }] });
      }) as unknown as typeof fetch,
    });

    const result = await client.chat([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('Recovered');
    expect(attempts).toBe(3);
  });
});
