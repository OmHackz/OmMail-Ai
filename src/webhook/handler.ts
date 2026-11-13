import type { App } from '../app';
import { toAppError } from '../lib/errors';
import { jsonResponse } from '../lib/http';
import { verifyWebhookRequest } from './verify';
import { parseWebhookPayload } from './adapter';
import type { ParsedWebhook } from './adapter';

/**
 * Webhook transport layer for DeoMail Fire deliveries.
 *
 * Authentication, size limits and payload validation live here so the
 * pipeline in `src/app.ts` only deals with business rules.
 */

export type FireEvent =
  | { ok: true; parsed: ParsedWebhook }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Authenticate a Fire delivery and map its payload to a canonical email.
 *
 * The payload profile is explicit (`canonical` or `extended`) — see
 * `src/webhook/adapter.ts` for what each profile expects.
 */
export function parseFireEvent(app: App, request: Request, rawBody: string): FireEvent {
  const auth = verifyWebhookRequest(request, rawBody, app.env);
  if (!auth.ok) {
    return { ok: false, status: 401, body: { ok: false, error: 'unauthorized' } };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody) as unknown;
  } catch {
    return { ok: false, status: 400, body: { ok: false, error: 'invalid_json' } };
  }

  try {
    const parsed = parseWebhookPayload(payload, { profile: app.webhookProfile });
    return { ok: true, parsed };
  } catch (error) {
    const appError = toAppError(error);
    return { ok: false, status: appError.status, body: { ok: false, error: appError.code } };
  }
}

/** Entry point used by `api/webhook.ts`. */
export async function handleWebhookRequest(app: App, request: Request): Promise<Response> {
  try {
    return await app.handleWebhook(request);
  } catch (error) {
    const appError = toAppError(error);
    return jsonResponse({ ok: false, error: appError.code }, { status: appError.status });
  }
}
