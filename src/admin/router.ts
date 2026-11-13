import { z } from 'zod';
import type { App } from '../app';
import { jsonResponse, methodNotAllowed, readJsonBody } from '../lib/http';
import { constantTimeEqual } from '../lib/security';
import { toAppError } from '../lib/errors';
import { buildSystemPrompt, buildUserPrompt, DEFAULT_SIGNATURE, sanitizeAiReply } from '../ai/prompts';
import type { Draft } from '../types';

/**
 * Admin API.
 *
 * Every route requires the shared admin secret (X-Admin-Secret header or
 * Authorization: Bearer). No API key, customer body or private configuration
 * is ever returned without that check.
 */

const approveSchema = z.object({
  text: z.string().max(20000).optional(),
  subject: z.string().max(500).optional(),
  send: z.boolean().optional(),
});

const settingsSchema = z.object({
  mode: z.enum(['draft', 'automatic', 'disabled']).optional(),
  enabled: z.boolean().optional(),
  systemPrompt: z.string().max(20000).nullable().optional(),
  signature: z.string().max(2000).nullable().optional(),
});

const manualDraftSchema = z.object({
  to: z.string().min(3),
  subject: z.string().min(1).max(500),
  text: z.string().min(1).max(20000),
});

const testAiSchema = z.object({
  message: z.string().min(1).max(12000),
  subject: z.string().max(500).optional(),
  from: z.string().optional(),
});

function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() ?? 'unknown';
  return request.headers.get('x-real-ip') ?? 'unknown';
}

export function isAdminRequest(request: Request, app: App): boolean {
  const headerSecret = request.headers.get('x-admin-secret') ?? '';
  const authorization = request.headers.get('authorization') ?? '';
  const bearer = authorization.replace(/^bearer\s+/i, '').trim();
  const provided = headerSecret || bearer;
  if (!provided) return false;
  return constantTimeEqual(provided, app.env.ADMIN_SECRET);
}

export async function handleAdminRequest(app: App, request: Request, subPath: string): Promise<Response> {
  if (!isAdminRequest(request, app)) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const limited = await enforceRateLimit(app, request);
  if (limited) return limited;

  const path = subPath.replace(/^\/+|\/+$/g, '');
  const segments = path.split('/').filter(Boolean);
  const method = request.method.toUpperCase();

  try {
    // ------------------------------------------------------------ overview --
    if (segments.length === 0 || segments[0] === 'overview') {
      if (method !== 'GET') return methodNotAllowed(['GET']);
      const [stats, daily, settings] = await Promise.all([
        app.repository.getStats(),
        app.repository.getDailyStats(new Date().toISOString().slice(0, 10)),
        app.resolveSettings(),
      ]);
      return jsonResponse({
        ok: true,
        app: { name: app.env.APP_NAME, version: app.env.APP_VERSION, url: app.env.APP_URL },
        settings,
        stats,
        daily,
      });
    }

    // --------------------------------------------------------------- stats --
    if (segments[0] === 'stats') {
      if (method !== 'GET') return methodNotAllowed(['GET']);
      const [stats, daily] = await Promise.all([
        app.repository.getStats(),
        app.repository.getDailyStats(new Date().toISOString().slice(0, 10)),
      ]);
      return jsonResponse({ ok: true, stats, daily });
    }

    // ------------------------------------------------------------ activity --
    if (segments[0] === 'activity') {
      if (method !== 'GET') return methodNotAllowed(['GET']);
      const url = new URL(request.url);
      const limit = clampInt(url.searchParams.get('limit') ?? '', 50, 1, 250);
      return jsonResponse({ ok: true, activity: await app.repository.listActivity(limit) });
    }

    // ----------------------------------------------------------- settings --
    if (segments[0] === 'settings') {
      if (method === 'GET') {
        const settings = await app.resolveSettings();
        return jsonResponse({ ok: true, settings });
      }
      if (method === 'POST' || method === 'PUT') {
        const body = await readJsonBody<unknown>(request, app.env.MAX_WEBHOOK_BYTES);
        const parsed = settingsSchema.parse(body);
        const patch: Record<string, unknown> = {};
        if (parsed.mode !== undefined) patch.mode = parsed.mode;
        if (parsed.enabled !== undefined) patch.enabled = parsed.enabled;
        if (parsed.systemPrompt !== undefined) patch.systemPrompt = parsed.systemPrompt ?? undefined;
        if (parsed.signature !== undefined) patch.signature = parsed.signature ?? undefined;
        const settings = await app.updateSettings(patch);
        return jsonResponse({ ok: true, settings });
      }
      return methodNotAllowed(['GET', 'POST']);
    }

    // --------------------------------------------------------- connection --
    if (segments[0] === 'connection') {
      if (method !== 'GET') return methodNotAllowed(['GET']);
      const [deomail, agnes] = await Promise.all([app.deomail.checkConnection(), app.agnes.ping()]);
      return jsonResponse({ ok: true, deomail, agnes });
    }

    // ------------------------------------------------------------ test AI --
    if (segments[0] === 'test-ai') {
      if (method !== 'POST') return methodNotAllowed(['POST']);
      const body = await readJsonBody<unknown>(request, app.env.MAX_WEBHOOK_BYTES);
      const parsed = testAiSchema.parse(body);
      const settings = await app.resolveSettings();
      const signature = settings.signature ?? DEFAULT_SIGNATURE;
      const email = {
        providerId: 'test',
        from: parsed.from ?? 'customer@example.com',
        fromEmail: parsed.from ?? 'customer@example.com',
        to: [app.env.DEOMAIL_SENDER],
        subject: parsed.subject ?? 'Test message',
        bodyText: parsed.message,
        headers: {},
        attachmentCount: 0,
        bodyFromApi: false,
        bodyIsPreview: false,
        rawPayload: null,
      };
      const completion = await app.agnes.chat([
        {
          role: 'system',
          content: buildSystemPrompt(settings.systemPrompt, { email, signature, mode: 'draft' }),
        },
        { role: 'user', content: buildUserPrompt({ email, mode: 'draft' }) },
      ]);
      const sanitized = sanitizeAiReply(completion.content, { signature, maxChars: app.env.MAX_AI_RESPONSE_CHARS });
      return jsonResponse({
        ok: true,
        model: completion.model,
        usage: completion.usage,
        reply: sanitized.text,
        issues: sanitized.issues,
      });
    }

    // -------------------------------------------------------------- drafts --
    if (segments[0] === 'drafts') {
      return await handleDrafts(app, request, segments, method);
    }

    return jsonResponse({ ok: false, error: 'not_found' }, { status: 404 });
  } catch (error) {
    const appError = toAppError(error);
    if (error instanceof z.ZodError) {
      return jsonResponse(
        { ok: false, error: 'invalid_request', issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
        { status: 400 },
      );
    }
    app.logger.error('admin.error', { errorCategory: appError.category, errorCode: appError.code });
    return jsonResponse(
      { ok: false, error: appError.expose ? appError.message : appError.code },
      { status: appError.status },
    );
  }
}

async function handleDrafts(
  app: App,
  request: Request,
  segments: string[],
  method: string,
): Promise<Response> {
  // /drafts
  if (segments.length === 1) {
    if (method === 'GET') {
      const url = new URL(request.url);
      const statusParam = url.searchParams.get('status');
      const limit = clampInt(url.searchParams.get('limit') ?? '', 50, 1, 200);
      const status = statusParam as Draft['status'] | null;
      const drafts = await app.repository.listDrafts(status ?? undefined, limit);
      return jsonResponse({ ok: true, drafts });
    }
    if (method === 'POST') {
      const body = await readJsonBody<unknown>(request, app.env.MAX_WEBHOOK_BYTES);
      const parsed = manualDraftSchema.parse(body);
      const draft = await app.createManualDraft(parsed);
      return jsonResponse({ ok: true, draft }, { status: 201 });
    }
    return methodNotAllowed(['GET', 'POST']);
  }

  const id = segments[1] ?? '';
  if (!id) return jsonResponse({ ok: false, error: 'not_found' }, { status: 404 });

  // /drafts/:id
  if (segments.length === 2) {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    const draft = await app.repository.getDraft(id);
    if (!draft) return jsonResponse({ ok: false, error: 'not_found' }, { status: 404 });
    return jsonResponse({ ok: true, draft });
  }

  const action = segments[2];

  if (action === 'approve') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    const body = await readJsonBody<unknown>(request, app.env.MAX_WEBHOOK_BYTES);
    const parsed = approveSchema.parse(body ?? {});
    const draft = await app.approveDraft(id, parsed);
    return jsonResponse({ ok: true, draft });
  }

  if (action === 'reject') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    const draft = await app.rejectDraft(id);
    return jsonResponse({ ok: true, draft });
  }

  if (action === 'regenerate') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    const draft = await app.regenerateDraft(id);
    return jsonResponse({ ok: true, draft });
  }

  return jsonResponse({ ok: false, error: 'not_found' }, { status: 404 });
}

async function enforceRateLimit(app: App, request: Request): Promise<Response | null> {
  const limit = app.env.ADMIN_RATE_LIMIT_PER_MINUTE;
  const ip = clientIp(request);
  const minute = Math.floor(Date.now() / 60000);
  const key = `admin:ratelimit:${ip}:${minute}`;
  const count = await app.storage.incr(key, 120);
  if (count > limit) {
    return jsonResponse({ ok: false, error: 'rate_limited' }, { status: 429 });
  }
  return null;
}

function clampInt(raw: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
