import { App } from './app';
import { toAppError } from './lib/errors';
import { jsonResponse } from './lib/http';
import { parseEnv } from './lib/env';

/**
 * Shared helpers for the Vercel function entry points.
 *
 * The functions stay thin: they build the application, delegate, and turn
 * unexpected failures into a safe JSON response.
 */

let cachedApp: App | null = null;

export function getApp(): App {
  if (!cachedApp) cachedApp = App.create();
  return cachedApp;
}

/** Reset the memoised app (used by tests). */
export function resetApp(): void {
  cachedApp = null;
}

/** Convert a startup failure into a safe response (never leaks secrets). */
export function handleStartupError(error: unknown): Response {
  const appError = toAppError(error);
  if (appError.category === 'config') {
    const missing = Array.isArray(appError.details?.missing) ? (appError.details?.missing as string[]) : [];
    return jsonResponse(
      {
        ok: false,
        error: 'configuration_error',
        message: 'The server is not configured correctly.',
        missing,
      },
      { status: 503 },
    );
  }
  return jsonResponse({ ok: false, error: 'internal_error' }, { status: 500 });
}

/** Extract the sub path of the admin router (e.g. `/api/admin/drafts`). */
export function adminSubPath(request: Request): string {
  const url = new URL(request.url);
  const match = url.pathname.match(/\/api\/admin(?:\/(.*))?$/);
  return match?.[1] ?? '';
}

/** Health probe that reports configuration problems by variable name only. */
export async function healthPayload(): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const timestamp = new Date().toISOString();
  try {
    const env = parseEnv(process.env as Record<string, unknown>);
    const app = getApp();
    let storageOk = false;
    try {
      storageOk = await app.storage.ping();
    } catch {
      storageOk = false;
    }
    const settings = await app.resolveSettings();
    return {
      ok: storageOk,
      status: storageOk ? 200 : 503,
      body: {
        ok: storageOk,
        status: storageOk ? 'healthy' : 'degraded',
        app: env.APP_NAME,
        version: env.APP_VERSION,
        mode: settings.mode,
        enabled: settings.enabled,
        storage: { provider: env.STORAGE_PROVIDER, reachable: storageOk },
        timestamp,
      },
    };
  } catch (error) {
    const appError = toAppError(error);
    const missing = Array.isArray(appError.details?.missing) ? (appError.details?.missing as string[]) : [];
    const issues = Array.isArray(appError.details?.issues) ? (appError.details?.issues as unknown[]) : [];
    return {
      ok: false,
      status: 503,
      body: {
        ok: false,
        status: 'misconfigured',
        missing,
        issues,
        timestamp,
      },
    };
  }
}
