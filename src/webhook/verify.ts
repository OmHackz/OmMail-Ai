import { createHmac, timingSafeEqual } from 'node:crypto';
import { constantTimeEqual } from '../lib/security';
import type { Env } from '../lib/env';

export type WebhookAuthMethod = 'header' | 'query' | 'bearer' | 'signature';

export interface WebhookAuthResult {
  ok: boolean;
  method?: WebhookAuthMethod;
  reason?: string;
}

/**
 * Authenticate an inbound webhook request.
 *
 * DeoMail Fire does **not** document a signed webhook (no HMAC header, no
 * signature field). What Fire does support, and this is what we rely on, is
 * a shared secret delivered by one of these mechanisms:
 *
 *   - "API Key" authentication with Location = Header  (recommended)
 *   - "API Key" authentication with Location = Query Parameter
 *   - "Bearer Token" authentication
 *
 * An optional HMAC-SHA256 body signature is implemented for forward
 * compatibility, but it is disabled by default because Fire cannot send one
 * today (WEBHOOK_SIGNATURE_ENABLED=true).
 */
export function verifyWebhookRequest(request: Request, rawBody: string, env: Env): WebhookAuthResult {
  const secret = env.WEBHOOK_SECRET;
  if (!secret) {
    return { ok: false, reason: 'webhook_secret_not_configured' };
  }

  const candidates: Array<{ value: string; method: WebhookAuthMethod }> = [];

  const headerValue = request.headers.get(env.WEBHOOK_SECRET_HEADER);
  if (headerValue) candidates.push({ value: headerValue, method: 'header' });

  const authorization = request.headers.get('authorization');
  if (authorization && /^bearer\s+/i.test(authorization)) {
    candidates.push({ value: authorization.replace(/^bearer\s+/i, '').trim(), method: 'bearer' });
  }

  if (env.WEBHOOK_ALLOW_QUERY_SECRET) {
    const url = new URL(request.url);
    const queryValue = url.searchParams.get(env.WEBHOOK_SECRET_QUERY_PARAM);
    if (queryValue) candidates.push({ value: queryValue, method: 'query' });
  }

  for (const candidate of candidates) {
    if (candidate.value && constantTimeEqual(candidate.value, secret)) {
      return { ok: true, method: candidate.method };
    }
  }

  if (env.WEBHOOK_SIGNATURE_ENABLED) {
    const signature = request.headers.get(env.WEBHOOK_SIGNATURE_HEADER);
    if (signature) {
      const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
      const provided = signature.replace(/^sha256=/i, '').trim();
      if (provided.length === expected.length) {
        const a = Buffer.from(provided, 'hex');
        const b = Buffer.from(expected, 'hex');
        if (a.length === b.length && timingSafeEqual(a, b)) {
          return { ok: true, method: 'signature' };
        }
      }
    }
  }

  return { ok: false, reason: 'invalid_webhook_secret' };
}
