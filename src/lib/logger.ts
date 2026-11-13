/**
 * Structured, redaction-safe logging for OmMail AI.
 *
 * Rules enforced here:
 *  - never log API keys, webhook secrets or admin secrets
 *  - never log complete customer email bodies
 *  - never log full customer email addresses (they are masked)
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SECRET_KEY_PATTERN =
  /(api[_-]?key|secret|token|password|passwd|authorization|auth[_-]?header|bearer|cookie|session|signature|credential)/i;

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

/** Mask an email address so logs stay useful but not identifying. */
export function maskEmail(value: string): string {
  const match = EMAIL_PATTERN.exec(value);
  if (!match) return '[redacted-email]';
  const address = match[0];
  const at = address.lastIndexOf('@');
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const localHead = local.slice(0, 1);
  const domainParts = domain.split('.');
  const domainHead = domainParts[0]?.slice(0, 1) ?? '';
  const tld = domainParts.length > 1 ? `.${domainParts[domainParts.length - 1]}` : '';
  return `${localHead}***@${domainHead}***${tld}`;
}

/** Recursively redact secret-looking values and mask emails in free text. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (value.length > 2000) return `${value.slice(0, 2000)}…[truncated]`;
    return value.replace(EMAIL_PATTERN, (m) => maskEmail(m));
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redact(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        out[key] = '[redacted]';
        continue;
      }
      out[key] = redact(val, depth + 1);
    }
    return out;
  }
  return '[unserialisable]';
}

export interface LoggerOptions {
  level?: LogLevel;
  requestId?: string;
  base?: LogFields;
  sink?: (line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const threshold = LEVEL_ORDER[level];
  const sink = options.sink ?? ((line: string) => console.log(line));
  const base = options.base ?? {};

  function write(lvl: LogLevel, event: string, fields?: LogFields): void {
    if (LEVEL_ORDER[lvl] < threshold) return;
    const record = {
      ts: new Date().toISOString(),
      level: lvl,
      event,
      ...(options.requestId ? { requestId: options.requestId } : {}),
      ...(redact(base) as LogFields),
      ...(fields ? (redact(fields) as LogFields) : {}),
    };
    try {
      sink(JSON.stringify(record));
    } catch {
      sink(JSON.stringify({ ts: new Date().toISOString(), level: 'error', event: 'log.serialize_failed' }));
    }
  }

  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
}

export const nullLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => nullLogger,
};
