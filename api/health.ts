import { healthPayload } from '../src/server';

/** Liveness / readiness probe. Never exposes secrets. */
export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(JSON.stringify({ ok: false, error: 'method_not_allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json; charset=utf-8', Allow: 'GET, HEAD' },
      });
    }

    const payload = await healthPayload();
    return new Response(JSON.stringify(payload.body), {
      status: payload.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  },
};
