import { AppError } from './errors';

export const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, max-age=0',
} as const;

/** Create a JSON response with hardened headers. */
export function jsonResponse(data: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { ...JSON_HEADERS, ...(init.headers ?? {}) },
  });
}

/**
 * Read a request body with a hard byte limit.
 * Rejects oversized payloads with HTTP 413 before they are buffered.
 */
export async function readBodyLimited(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get('content-length');
  if (declared) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new AppError('Payload too large', {
        category: 'validation',
        code: 'PAYLOAD_TOO_LARGE',
        status: 413,
        details: { maxBytes, declaredLength: length },
      });
    }
  }

  const body = request.body;
  if (!body) return '';

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AppError('Payload too large', {
          category: 'validation',
          code: 'PAYLOAD_TOO_LARGE',
          status: 413,
          details: { maxBytes },
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(merged);
}

/** Parse a JSON body with a friendly validation error. */
export async function readJsonBody<T = unknown>(request: Request, maxBytes: number): Promise<T> {
  const raw = await readBodyLimited(request, maxBytes);
  if (!raw.trim()) {
    throw new AppError('Request body is empty', {
      category: 'validation',
      code: 'EMPTY_BODY',
      status: 400,
    });
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new AppError('Request body is not valid JSON', {
      category: 'validation',
      code: 'INVALID_JSON',
      status: 400,
    });
  }
}

/** Allow only the listed HTTP methods; returns 405 otherwise. */
export function methodNotAllowed(allowed: string[]): Response {
  return jsonResponse(
    { ok: false, error: 'method_not_allowed', allowed },
    { status: 405, headers: { Allow: allowed.join(', ') } },
  );
}
