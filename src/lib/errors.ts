/**
 * Typed application errors.
 *
 * Every failure is classified into an `ErrorCategory` so that:
 *  - the webhook can decide whether a retry is safe
 *  - logs stay consistent
 *  - HTTP responses never leak internals
 */

export type ErrorCategory =
  | 'config'
  | 'auth'
  | 'validation'
  | 'blocked'
  | 'duplicate'
  | 'rate_limit'
  | 'timeout'
  | 'upstream'
  | 'storage'
  | 'internal';

export interface AppErrorOptions {
  category: ErrorCategory;
  code?: string;
  status?: number;
  retryable?: boolean;
  /** True when the upstream may have accepted the request (e.g. send timed out). */
  deliveryUnknown?: boolean;
  /** Message safe to return to the caller. */
  expose?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

const DEFAULT_STATUS: Record<ErrorCategory, number> = {
  config: 500,
  auth: 401,
  validation: 400,
  blocked: 422,
  duplicate: 200,
  rate_limit: 429,
  timeout: 504,
  upstream: 502,
  storage: 503,
  internal: 500,
};

export class AppError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly deliveryUnknown: boolean;
  readonly expose: boolean;
  readonly details: Record<string, unknown>;

  constructor(message: string, options: AppErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.category = options.category;
    this.code = options.code ?? options.category.toUpperCase();
    this.status = options.status ?? DEFAULT_STATUS[options.category];
    this.retryable = options.retryable ?? false;
    this.deliveryUnknown = options.deliveryUnknown ?? false;
    this.expose = options.expose ?? (options.category === 'validation' || options.category === 'blocked');
    this.details = options.details ?? {};
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Normalise any thrown value into an AppError. */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) return value;

  if (value instanceof Error) {
    const name = value.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new AppError('Operation timed out', { category: 'timeout', cause: value });
    }
    if (name === 'TypeError' && /fetch failed|network/i.test(value.message)) {
      return new AppError('Network request failed', { category: 'upstream', retryable: true, cause: value });
    }
    return new AppError(value.message || 'Unexpected error', { category: 'internal', cause: value });
  }

  return new AppError('Unexpected error', { category: 'internal', details: { thrown: String(value) } });
}

export class ConfigError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { category: 'config', code: 'CONFIG_INVALID', details, expose: false });
    this.name = 'ConfigError';
  }
}
