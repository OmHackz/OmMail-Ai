import { z } from 'zod';
import { AppError } from '../lib/errors';

/**
 * Agnes AI client — OpenAI compatible Chat Completions API.
 *
 * Endpoint : POST {AGNES_BASE_URL}/chat/completions
 * Auth     : Authorization: Bearer {AGNES_API_KEY}
 */

const contentPartSchema = z.object({
  type: z.string().optional(),
  text: z.string().optional(),
});

const chatCompletionSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  created: z.number().optional(),
  choices: z
    .array(
      z.object({
        index: z.number().optional(),
        finish_reason: z.string().nullish(),
        message: z
          .object({
            role: z.string().optional(),
            content: z.union([z.string(), z.array(contentPartSchema), z.null()]).optional(),
          })
          .passthrough()
          .optional(),
      }),
    )
    .optional(),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
    })
    .optional(),
  error: z
    .object({
      message: z.string().optional(),
      code: z.union([z.string(), z.number()]).optional(),
      type: z.string().optional(),
    })
    .passthrough()
    .optional(),
});

export interface AgnesUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AgnesChatResult {
  content: string;
  model: string;
  finishReason?: string;
  usage?: AgnesUsage;
  requestId?: string;
  attempts: number;
}

export interface AgnesClientOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  maxRetries: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface AgnesChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 522, 524]);

export class AgnesClient {
  private readonly options: AgnesClientOptions;

  constructor(options: AgnesClientOptions) {
    this.options = options;
  }

  private get endpoint(): string {
    const base = this.options.baseUrl.replace(/\/+$/, '');
    return `${base}/chat/completions`;
  }

  private sleep(ms: number): Promise<void> {
    if (this.options.sleepImpl) return this.options.sleepImpl(ms);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Send a chat completion request with safe retries for transient failures. */
  async chat(messages: AgnesChatMessage[], overrides: { temperature?: number; maxTokens?: number } = {}): Promise<AgnesChatResult> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const temperature = overrides.temperature ?? this.options.temperature;
    const maxTokens = overrides.maxTokens ?? this.options.maxTokens;

    // Only parameters documented for the Agnes chat endpoint are sent.
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages,
      stream: false,
      temperature,
      max_tokens: maxTokens,
    };

    let lastError: AppError | null = null;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      try {
        return await this.execute(fetchImpl, body, attempt);
      } catch (error) {
        const appError = error instanceof AppError ? error : new AppError('Agnes request failed', { category: 'upstream' });
        lastError = appError;

        const canRetry = appError.retryable && attempt < this.options.maxRetries;
        if (!canRetry) break;

        const backoff = Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
        await this.sleep(backoff);
      }
    }

    throw lastError ?? new AppError('Agnes request failed', { category: 'upstream' });
  }

  private async execute(
    fetchImpl: typeof fetch,
    body: Record<string, unknown>,
    attempt: number,
  ): Promise<AgnesChatResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new AppError('Agnes AI request timed out', {
          category: 'timeout',
          code: 'AGNES_TIMEOUT',
          status: 504,
          retryable: true,
          details: { timeoutMs: this.options.timeoutMs, attempt },
        });
      }
      throw new AppError('Agnes AI is unreachable', {
        category: 'upstream',
        code: 'AGNES_NETWORK_ERROR',
        status: 502,
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    const requestId = response.headers.get('x-request-id') ?? undefined;

    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new AppError('Agnes AI returned a non-JSON response', {
        category: 'upstream',
        code: 'AGNES_INVALID_JSON',
        status: 502,
        details: { status: response.status },
      });
    }

    const result = chatCompletionSchema.safeParse(parsed);
    if (!result.success) {
      throw new AppError('Agnes AI returned an unexpected response shape', {
        category: 'upstream',
        code: 'AGNES_INVALID_RESPONSE',
        status: 502,
        details: { status: response.status },
      });
    }

    const payload = result.data;

    // The API may report failures with HTTP 200 and an `error` envelope.
    if (payload.error) {
      const message = payload.error.message ?? 'Agnes AI request failed';
      const code = payload.error.code !== undefined ? String(payload.error.code) : undefined;
      throw this.mapError(response.status, message, code, attempt, requestId);
    }

    if (!response.ok) {
      throw this.mapError(response.status, `Agnes AI request failed with status ${response.status}`, undefined, attempt, requestId);
    }

    const choice = payload.choices?.[0];
    const content = extractContent(choice?.message?.content);

    if (!content) {
      throw new AppError('Agnes AI returned an empty completion', {
        category: 'upstream',
        code: 'AGNES_EMPTY_COMPLETION',
        status: 502,
        retryable: true,
        details: { attempt },
      });
    }

    return {
      content,
      model: payload.model ?? this.options.model,
      finishReason: choice?.finish_reason ?? undefined,
      usage: payload.usage
        ? {
            promptTokens: payload.usage.prompt_tokens,
            completionTokens: payload.usage.completion_tokens,
            totalTokens: payload.usage.total_tokens,
          }
        : undefined,
      requestId,
      attempts: attempt + 1,
    };
  }

  private mapError(status: number, message: string, code: string | undefined, attempt: number, requestId?: string): AppError {
    const details = { status, code, attempt, requestId, upstreamMessage: message?.slice(0, 300) };
    if (status === 401 || status === 403) {
      return new AppError('Agnes AI authentication failed', {
        category: 'auth',
        code: 'AGNES_AUTH_FAILED',
        status: 502,
        details,
      });
    }
    if (status === 402) {
      return new AppError('Agnes AI quota exhausted', {
        category: 'rate_limit',
        code: 'AGNES_QUOTA_EXCEEDED',
        status: 429,
        details,
      });
    }
    if (status === 429) {
      return new AppError('Agnes AI rate limit reached', {
        category: 'rate_limit',
        code: 'AGNES_RATE_LIMITED',
        status: 429,
        retryable: true,
        details,
      });
    }
    if (status === 400 || status === 404 || status === 405 || status === 422) {
      return new AppError('Agnes AI rejected the request', {
        category: 'validation',
        code: 'AGNES_BAD_REQUEST',
        status: 502,
        details,
      });
    }
    if (status === 408 || status === 504 || status === 524) {
      return new AppError('Agnes AI request timed out', {
        category: 'timeout',
        code: 'AGNES_TIMEOUT',
        status: 504,
        retryable: RETRYABLE_STATUS.has(status),
        details,
      });
    }
    if (RETRYABLE_STATUS.has(status)) {
      return new AppError('Agnes AI is temporarily unavailable', {
        category: 'upstream',
        code: 'AGNES_UPSTREAM_ERROR',
        status: 502,
        retryable: true,
        details,
      });
    }
    return new AppError('Agnes AI request failed', {
      category: 'upstream',
      code: code ?? 'AGNES_ERROR',
      status: 502,
      retryable: false,
      details,
    });
  }

  /** Cheap connectivity probe used by the admin dashboard. */
  async ping(): Promise<{ ok: boolean; error?: string; model: string }> {
    try {
      const result = await this.chat(
        [{ role: 'user', content: 'ping' }],
        { maxTokens: 16, temperature: 0 },
      );
      return { ok: true, model: result.model };
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError('Unknown error', { category: 'internal' });
      return { ok: false, error: appError.message, model: this.options.model };
    }
  }
}

function extractContent(content: string | Array<{ type?: string; text?: string }> | null | undefined): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
  }
  return '';
}
