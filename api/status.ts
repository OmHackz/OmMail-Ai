import { getApp, handleStartupError } from '../src/server';
import { jsonResponse } from '../src/lib/http';

/**
 * Public, aggregate-only status endpoint.
 * It never exposes API keys, customer email bodies or private configuration.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse({ ok: false, error: 'method_not_allowed' }, { status: 405 });
    }

    try {
      const app = getApp();
      const [settings, stats] = await Promise.all([
        app.resolveSettings(),
        app.repository.getStats(),
      ]);

      return jsonResponse({
        ok: true,
        app: app.env.APP_NAME,
        version: app.env.APP_VERSION,
        mode: settings.mode,
        enabled: settings.enabled,
        stats,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      return handleStartupError(error);
    }
  },
};
