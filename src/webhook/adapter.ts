import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { extractDisplayName, extractEmailAddress } from '../lib/security';
import type { IncomingEmail } from '../types';

/**
 * DeoMail Fire webhook adapter.
 *
 * IMPORTANT — what is actually documented about Fire webhooks:
 *
 *  - Fire sends an HTTP request with the method, URL, custom headers and a JSON
 *    body template that YOU configure in the Fire dashboard
 *    (DeoMail app → Automations → action "Webhook (HTTP)").
 *  - The template variables Fire exposes are:
 *      {{from}} {{to}} {{subject}} {{body}} {{email_id}}
 *    plus {{date}} {{received_at}} {{attachment_count}} used by DeoMail's own
 *    Zapier / n8n / Make presets.
 *  - DeoMail does NOT publish a fixed, canonical inbound webhook schema.
 *    The body is entirely determined by the configured template.
 *
 * Because of that this adapter works with an explicit, documented profile
 * instead of guessing:
 *
 *   profile "canonical" (default) — the template DeoMail generates for its
 *     Zapier / n8n / Make integrations:
 *       { "event": "fire.triggered", "message_id": "{{email_id}}", "from": "{{from}}",
 *         "subject": "{{subject}}", "preview": "{{body}}",
 *         "received_at": "{{received_at}}", "attachment_count": "{{attachment_count}}" }
 *
 *   profile "extended" — canonical plus `to`, `body_text`, `body_html`, `headers`.
 *
 * A small, explicit alias table is accepted for each logical field so that a
 * slightly different (but still Fire generated) template keeps working.
 * Unknown fields are ignored — they are never interpreted.
 */

export const WEBHOOK_PROFILES = ['canonical', 'extended'] as const;
export type WebhookProfile = (typeof WEBHOOK_PROFILES)[number];

export const FIELD_ALIASES: Record<string, string[]> = {
  id: ['message_id', 'email_id', 'id'],
  from: ['from', 'from_addr', 'from_address', 'sender'],
  to: ['to', 'to_addrs', 'to_address', 'recipient'],
  subject: ['subject'],
  body: ['preview', 'body', 'body_text', 'text', 'snippet', 'preview_text'],
  html: ['body_html', 'html'],
  headers: ['headers', 'email_headers'],
  receivedAt: ['received_at', 'date', 'timestamp', 'created_at'],
  attachmentCount: ['attachment_count', 'attachments_count'],
  event: ['event', 'type', 'event_type'],
};

const rawPayloadSchema = z.record(z.string(), z.unknown());

export interface ParsedWebhook {
  email: IncomingEmail;
  event?: string;
  /** True when the body came from a `{{body}}` preview and may be truncated. */
  bodyIsPreview: boolean;
  /** True when no provider id was supplied (dedupe falls back to a payload hash). */
  syntheticId: boolean;
}

function pick(source: Record<string, unknown>, field: string): unknown {
  for (const alias of FIELD_ALIASES[field] ?? [field]) {
    const value = source[alias];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(/[,;]/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  if (Array.isArray(value)) {
    return value.map((item) => asString(item)).filter((item): item is string => Boolean(item));
  }
  return [];
}

function asHeaders(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!value || typeof value !== 'object') return headers;
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry && typeof entry === 'object' && 'key' in entry) {
        const key = String((entry as { key: unknown }).key ?? '').toLowerCase();
        const val = (entry as { value?: unknown }).value;
        if (key) headers[key] = String(val ?? '');
      }
    }
    return headers;
  }
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    headers[key.toLowerCase()] = typeof val === 'string' ? val : JSON.stringify(val);
  }
  return headers;
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

/**
 * Parse a raw webhook payload into the canonical inbound email shape.
 * Throws an `AppError` (validation) when the payload cannot be understood.
 */
export function parseWebhookPayload(
  payload: unknown,
  options: { profile: WebhookProfile },
): ParsedWebhook {
  const parsed = rawPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppError('Webhook payload must be a JSON object', {
      category: 'validation',
      code: 'INVALID_PAYLOAD',
      status: 422,
    });
  }

  const source = parsed.data;

  const rawFrom = asString(pick(source, 'from'));
  const fromEmail = extractEmailAddress(rawFrom);
  if (!fromEmail) {
    throw new AppError('Webhook payload does not contain a valid sender address', {
      category: 'validation',
      code: 'MISSING_SENDER',
      status: 422,
    });
  }

  const rawId = asString(pick(source, 'id'));
  const syntheticId = !rawId || rawId.trim().length === 0;
  const providerId = syntheticId ? `sha256:${stableHash(source).slice(0, 32)}` : rawId.trim();

  const bodyValue = pick(source, 'body');
  const bodyText = asString(bodyValue) ?? '';
  const htmlValue = pick(source, 'html');
  const bodyHtml = options.profile === 'extended' ? asString(htmlValue) ?? '' : '';

  const headers = options.profile === 'extended' ? asHeaders(pick(source, 'headers')) : {};

  const subject = asString(pick(source, 'subject')) ?? '';
  const to = asStringArray(pick(source, 'to'));
  const attachmentCount = asNumber(pick(source, 'attachmentCount')) ?? 0;
  const receivedAt = asString(pick(source, 'receivedAt'));
  const event = asString(pick(source, 'event'));

  const email: IncomingEmail = {
    providerId,
    from: rawFrom ?? fromEmail,
    fromEmail,
    fromName: extractDisplayName(rawFrom),
    to,
    subject,
    bodyText,
    bodyHtml: bodyHtml || undefined,
    headers,
    receivedAt,
    attachmentCount,
    bodyFromApi: false,
    bodyIsPreview: true,
    rawPayload: payload,
  };

  return { email, event, bodyIsPreview: true, syntheticId };
}

/** Profile used when the application starts; validated against the env. */
export function resolveProfile(value: string | undefined): WebhookProfile {
  return value && (WEBHOOK_PROFILES as readonly string[]).includes(value) ? (value as WebhookProfile) : 'canonical';
}
