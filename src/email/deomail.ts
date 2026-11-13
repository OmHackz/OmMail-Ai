import { z } from 'zod';
import { AppError } from '../lib/errors';
import type { DeoMailEmail, SendEmailInput, SendEmailResult } from '../types';

/**
 * DeoMail REST API client.
 *
 * Base URL : https://api.deomail.com/v1
 * Auth     : X-API-Key: {DEOMAIL_API_KEY}
 *
 * Documented endpoints used here:
 *   POST /send
 *   GET  /emails
 *   GET  /emails/:id
 */

const emailSchema = z
  .object({
    id: z.string().optional(),
    from_addr: z.string().optional(),
    from: z.string().optional(),
    to_addrs: z.array(z.string()).optional(),
    to: z.array(z.string()).optional(),
    subject: z.string().optional(),
    body_text: z.string().optional(),
    text: z.string().optional(),
    body_html: z.string().optional(),
    html: z.string().optional(),
    headers: z.union([z.record(z.string(), z.unknown()), z.array(z.object({ key: z.string(), value: z.string() }))]).optional(),
    received_at: z.string().optional(),
    created_at: z.string().optional(),
    has_attachments: z.boolean().optional(),
    attachments: z
      .array(
        z.object({
          id: z.string().optional(),
          filename: z.string().optional(),
          mime_type: z.string().optional(),
          size_bytes: z.number().optional(),
        }),
      )
      .optional(),
  })
  .passthrough();

const sendResponseSchema = z
  .object({
    success: z.boolean().optional(),
    email_id: z.string().optional(),
    message_id: z.string().optional(),
    fingerprint_id: z.string().optional(),
    error: z.union([z.string(), z.object({ message: z.string().optional(), code: z.string().optional() })]).optional(),
    code: z.string().optional(),
  })
  .passthrough();

const listResponseSchema = z
  .object({
    success: z.boolean().optional(),
    data: z.array(emailSchema).optional(),
    emails: z.array(emailSchema).optional(),
    pagination: z
      .object({
        page: z.number().optional(),
        limit: z.number().optional(),
        total: z.number().optional(),
        total_pages: z.number().optional(),
      })
      .optional(),
    error: z.union([z.string(), z.object({ message: z.string().optional(), code: z.string().optional() })]).optional(),
    code: z.string().optional(),
  })
  .passthrough();

const getResponseSchema = z
  .object({
    success: z.boolean().optional(),
    email: emailSchema.optional(),
    error: z.union([z.string(), z.object({ message: z.string().optional(), code: z.string().optional() })]).optional(),
    code: z.string().optional(),
  })
  .passthrough();

export interface DeoMailClientOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface ListEmailsParams {
  page?: number;
  limit?: number;
  folder?: string;
  search?: string;
  from?: string;
  to?: string;
  from_domain?: string;
  from_date?: string;
  to_date?: string;
  has_attachment?: boolean;
  is_read?: boolean;
  status?: string;
  direction?: string;
  sort?: string;
  order?: string;
}

export interface ListEmailsResult {
  emails: DeoMailEmail[];
  pagination: { page?: number; limit?: number; total?: number; totalPages?: number };
  raw: unknown;
}

const AUTH_ERROR_CODES = new Set(['UNAUTHORIZED', 'INVALID_KEY', 'KEY_INACTIVE', 'KEY_EXPIRED']);
const PERMISSION_ERROR_CODES = new Set([
  'PERMISSION_DENIED',
  'SENDER_NOT_AUTHORIZED',
  'RISK_BLOCKED',
  'FINGERPRINT_REQUIRES_PLAN',
]);
const RATE_LIMIT_CODES = new Set(['RATE_LIMITED', 'QUOTA_EXCEEDED']);

export class DeoMailClient {
  private readonly options: DeoMailClientOptions;

  constructor(options: DeoMailClientOptions) {
    this.options = options;
  }

  private url(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    const base = this.options.baseUrl.replace(/\/+$/, '');
    const url = new URL(`${base}/${path.replace(/^\/+/, '')}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private sleep(ms: number): Promise<void> {
    if (this.options.sleepImpl) return this.options.sleepImpl(ms);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Send an email.
   *
   * Retry policy: only a definitive "not accepted" answer is retried (429).
   * Timeouts and 5xx responses are *not* retried because the message may
   * already have been accepted — `deliveryUnknown` is set instead.
   */
  async sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
    const payload: Record<string, unknown> = {
      from: input.from,
      to: input.to,
      subject: input.subject,
    };
    if (input.text) payload.text = input.text;
    if (input.html) payload.html = input.html;
    if (input.cc?.length) payload.cc = input.cc;
    if (input.bcc?.length) payload.bcc = input.bcc;
    if (typeof input.fingerprint === 'boolean') payload.fingerprint = input.fingerprint;

    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

      let response: Response;
      try {
        response = await fetchImpl(this.url('send'), {
          method: 'POST',
          headers: {
            'X-API-Key': this.options.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        const name = error instanceof Error ? error.name : '';
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new AppError('DeoMail send timed out — delivery state is unknown', {
            category: 'timeout',
            code: 'DEOMAIL_SEND_TIMEOUT',
            status: 504,
            retryable: false,
            deliveryUnknown: true,
            details: { attempt, timeoutMs: this.options.timeoutMs },
          });
        }
        throw new AppError('DeoMail is unreachable — delivery state is unknown', {
          category: 'upstream',
          code: 'DEOMAIL_NETWORK_ERROR',
          status: 502,
          retryable: false,
          deliveryUnknown: true,
          cause: error,
        });
      }

      const text = await response.text();
      clearTimeout(timer);

      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        throw new AppError('DeoMail returned a non-JSON response', {
          category: 'upstream',
          code: 'DEOMAIL_INVALID_JSON',
          status: 502,
          deliveryUnknown: response.ok,
          details: { status: response.status },
        });
      }

      const result = sendResponseSchema.safeParse(parsed);
      if (!result.success) {
        throw new AppError('DeoMail returned an unexpected response shape', {
          category: 'upstream',
          code: 'DEOMAIL_INVALID_RESPONSE',
          status: 502,
          deliveryUnknown: response.ok,
          details: { status: response.status },
        });
      }

      const data = result.data;
      const errorMessage = extractErrorMessage(data.error);
      const errorCode = data.code ?? extractErrorCode(data.error);

      // Logical errors can be delivered with HTTP 200.
      if (errorMessage) {
        const error = this.mapError(response.status, errorMessage, errorCode);
        if (error.retryable && attempt < this.options.maxRetries) {
          await this.sleep(Math.min(5000, 500 * 2 ** attempt));
          continue;
        }
        throw error;
      }

      if (!response.ok) {
        const error = this.mapError(response.status, `DeoMail request failed with status ${response.status}`, errorCode);
        if (error.retryable && attempt < this.options.maxRetries) {
          await this.sleep(Math.min(5000, 500 * 2 ** attempt));
          continue;
        }
        throw error;
      }

      return {
        success: data.success !== false,
        emailId: data.email_id,
        messageId: data.message_id,
        fingerprintId: data.fingerprint_id,
        raw: data,
      };
    }

    throw new AppError('DeoMail send failed', { category: 'upstream', code: 'DEOMAIL_SEND_FAILED' });
  }

  /** Fetch a single email including its body. */
  async getEmail(id: string): Promise<DeoMailEmail | null> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(this.url(`emails/${encodeURIComponent(id)}`), {
        method: 'GET',
        headers: { 'X-API-Key': this.options.apiKey },
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new AppError('DeoMail request timed out', {
          category: 'timeout',
          code: 'DEOMAIL_TIMEOUT',
          status: 504,
          retryable: true,
        });
      }
      throw new AppError('DeoMail is unreachable', {
        category: 'upstream',
        code: 'DEOMAIL_NETWORK_ERROR',
        status: 502,
        retryable: true,
        cause: error,
      });
    }

    const text = await response.text();
    clearTimeout(timer);

    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new AppError('DeoMail returned a non-JSON response', {
        category: 'upstream',
        code: 'DEOMAIL_INVALID_JSON',
        status: 502,
        details: { status: response.status },
      });
    }

    const result = getResponseSchema.safeParse(parsed);
    if (!result.success) {
      throw new AppError('DeoMail returned an unexpected response shape', {
        category: 'upstream',
        code: 'DEOMAIL_INVALID_RESPONSE',
        status: 502,
        details: { status: response.status },
      });
    }

    const data = result.data;
    const errorMessage = extractErrorMessage(data.error);
    if (errorMessage) {
      if (response.status === 404) return null;
      throw this.mapError(response.status, errorMessage, data.code ?? extractErrorCode(data.error));
    }

    if (!response.ok) {
      if (response.status === 404) return null;
      throw this.mapError(response.status, `DeoMail request failed with status ${response.status}`, data.code);
    }

    if (!data.email) return null;
    return mapEmail(data.email, data.email.id ?? id);
  }

  /** List emails. */
  async listEmails(params: ListEmailsParams = {}): Promise<ListEmailsResult> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(
        this.url('emails', {
          page: params.page,
          limit: params.limit,
          folder: params.folder,
          search: params.search,
          from: params.from,
          to: params.to,
          from_domain: params.from_domain,
          from_date: params.from_date,
          to_date: params.to_date,
          has_attachment: params.has_attachment,
          is_read: params.is_read,
          status: params.status,
          direction: params.direction,
          sort: params.sort,
          order: params.order,
        }),
        {
          method: 'GET',
          headers: { 'X-API-Key': this.options.apiKey },
          signal: controller.signal,
        },
      );
    } catch (error) {
      clearTimeout(timer);
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new AppError('DeoMail request timed out', {
          category: 'timeout',
          code: 'DEOMAIL_TIMEOUT',
          status: 504,
          retryable: true,
        });
      }
      throw new AppError('DeoMail is unreachable', {
        category: 'upstream',
        code: 'DEOMAIL_NETWORK_ERROR',
        status: 502,
        retryable: true,
        cause: error,
      });
    }

    const text = await response.text();
    clearTimeout(timer);

    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new AppError('DeoMail returned a non-JSON response', {
        category: 'upstream',
        code: 'DEOMAIL_INVALID_JSON',
        status: 502,
        details: { status: response.status },
      });
    }

    const result = listResponseSchema.safeParse(parsed);
    if (!result.success) {
      throw new AppError('DeoMail returned an unexpected response shape', {
        category: 'upstream',
        code: 'DEOMAIL_INVALID_RESPONSE',
        status: 502,
        details: { status: response.status },
      });
    }

    const data = result.data;
    const errorMessage = extractErrorMessage(data.error);
    if (errorMessage) {
      throw this.mapError(response.status, errorMessage, data.code ?? extractErrorCode(data.error));
    }
    if (!response.ok) {
      throw this.mapError(response.status, `DeoMail request failed with status ${response.status}`, data.code);
    }

    const rawEmails = data.data ?? data.emails ?? [];
    return {
      emails: rawEmails.map((email, index) => mapEmail(email, email.id ?? `index-${index}`)),
      pagination: {
        page: data.pagination?.page,
        limit: data.pagination?.limit,
        total: data.pagination?.total,
        totalPages: data.pagination?.total_pages,
      },
      raw: data,
    };
  }

  /** Verify that the configured API key works. */
  async checkConnection(): Promise<{ ok: boolean; error?: string; code?: string; emailCount?: number }> {
    try {
      const result = await this.listEmails({ limit: 1, folder: 'inbox' });
      return { ok: true, emailCount: result.emails.length };
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError('Unknown error', { category: 'internal' });
      return { ok: false, error: appError.message, code: appError.code };
    }
  }

  private mapError(status: number, message: string, code?: string): AppError {
    const details = { status, code, upstreamMessage: message?.slice(0, 300) };
    if (status === 401 || (code && AUTH_ERROR_CODES.has(code))) {
      return new AppError('DeoMail authentication failed', {
        category: 'auth',
        code: code ?? 'DEOMAIL_AUTH_FAILED',
        status: 502,
        details,
      });
    }
    if (status === 403 || (code && PERMISSION_ERROR_CODES.has(code))) {
      return new AppError('DeoMail refused the request', {
        category: 'blocked',
        code: code ?? 'DEOMAIL_PERMISSION_DENIED',
        status: 502,
        details,
      });
    }
    if (status === 429 || (code && RATE_LIMIT_CODES.has(code))) {
      return new AppError('DeoMail rate limit reached', {
        category: 'rate_limit',
        code: code ?? 'DEOMAIL_RATE_LIMITED',
        status: 429,
        retryable: true,
        details,
      });
    }
    if (status === 400 || status === 404 || status === 413 || status === 422) {
      return new AppError('DeoMail rejected the request', {
        category: 'validation',
        code: code ?? 'DEOMAIL_BAD_REQUEST',
        status: 502,
        details,
      });
    }
    if (status === 500 && code === 'DELIVERY_FAILED') {
      return new AppError('DeoMail accepted the message but delivery failed', {
        category: 'upstream',
        code: 'DEOMAIL_DELIVERY_FAILED',
        status: 502,
        deliveryUnknown: false,
        details,
      });
    }
    if (status >= 500) {
      return new AppError('DeoMail is temporarily unavailable', {
        category: 'upstream',
        code: code ?? 'DEOMAIL_UPSTREAM_ERROR',
        status: 502,
        retryable: false,
        deliveryUnknown: true,
        details,
      });
    }
    return new AppError('DeoMail request failed', {
      category: 'upstream',
      code: code ?? 'DEOMAIL_ERROR',
      status: 502,
      details,
    });
  }
}

function extractErrorMessage(error: unknown): string | undefined {
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return undefined;
}

function extractErrorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim()) return code.trim();
  }
  return undefined;
}

function mapEmail(email: z.infer<typeof emailSchema>, fallbackId: string): DeoMailEmail {
  const headers: Record<string, string> = {};
  const rawHeaders = email.headers;
  if (Array.isArray(rawHeaders)) {
    for (const header of rawHeaders) {
      if (header?.key) headers[header.key.toLowerCase()] = String(header.value ?? '');
    }
  } else if (rawHeaders && typeof rawHeaders === 'object') {
    for (const [key, value] of Object.entries(rawHeaders)) {
      headers[key.toLowerCase()] = typeof value === 'string' ? value : JSON.stringify(value);
    }
  }

  return {
    id: email.id ?? fallbackId,
    from: email.from_addr ?? email.from ?? headers.from ?? '',
    to: email.to_addrs ?? email.to ?? [],
    subject: email.subject ?? headers.subject ?? '',
    bodyText: email.body_text ?? email.text ?? '',
    bodyHtml: email.body_html ?? email.html ?? '',
    headers,
    receivedAt: email.received_at ?? email.created_at ?? undefined,
    hasAttachments: email.has_attachments ?? false,
    attachments: (email.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mime_type,
      sizeBytes: attachment.size_bytes,
    })),
    raw: email,
  };
}
