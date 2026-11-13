import { describe, expect, it } from 'vitest';
import { handleAdminRequest } from '../src/admin/router';
import { adminRequest, createHarness, readJson, samplePayload } from './fixtures';

describe('admin API', () => {
  it('rejects requests without the admin secret', async () => {
    const harness = createHarness();
    const response = await handleAdminRequest(harness.app, adminRequest('/stats', { secret: null }), 'stats');
    expect(response.status).toBe(401);
  });

  it('rejects requests with a wrong admin secret', async () => {
    const harness = createHarness();
    const response = await handleAdminRequest(harness.app, adminRequest('/stats', { secret: 'nope' }), 'stats');
    expect(response.status).toBe(401);
  });

  it('accepts the admin secret in the Authorization header', async () => {
    const harness = createHarness();
    const request = new Request('https://mailbot.omhackz.top/api/admin/stats', {
      headers: { authorization: 'Bearer test-admin-secret-0123456789' },
    });
    const response = await handleAdminRequest(harness.app, request, 'stats');
    expect(response.status).toBe(200);
  });

  it('returns an overview with usage statistics', async () => {
    const harness = createHarness();
    await harness.app.handleWebhook(harness.webhook(samplePayload()));
    const response = await handleAdminRequest(harness.app, adminRequest(''), '');
    const body = await readJson<{ ok: boolean; stats: { processed: number; draftsPending: number }; settings: { mode: string } }>(
      response,
    );
    expect(body.ok).toBe(true);
    expect(body.stats.processed).toBe(1);
    expect(body.stats.draftsPending).toBe(1);
    expect(body.settings.mode).toBe('draft');
  });

  it('lists drafts without exposing anything to unauthenticated callers', async () => {
    const harness = createHarness();
    await harness.app.handleWebhook(harness.webhook(samplePayload()));

    const unauthorized = await handleAdminRequest(harness.app, adminRequest('/drafts', { secret: null }), 'drafts');
    expect(unauthorized.status).toBe(401);

    const authorized = await handleAdminRequest(harness.app, adminRequest('/drafts'), 'drafts');
    const body = await readJson<{ drafts: Array<{ status: string; to: string }> }>(authorized);
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0]?.status).toBe('pending');
  });

  it('approves a draft and sends it through DeoMail', async () => {
    const harness = createHarness();
    await harness.app.handleWebhook(harness.webhook(samplePayload()));
    const drafts = await harness.app.repository.listDrafts();
    const draftId = drafts[0]?.id as string;

    const response = await handleAdminRequest(
      harness.app,
      adminRequest(`/drafts/${draftId}/approve`, { method: 'POST', body: {} }),
      `drafts/${draftId}/approve`,
    );
    expect(response.status).toBe(200);

    const sends = harness.calls.deomail.filter((call) => call.url.includes('/v1/send'));
    expect(sends).toHaveLength(1);
    expect((sends[0]?.body as { to: string[] }).to).toEqual(['jane@example.com']);

    const updated = await harness.app.repository.getDraft(draftId);
    expect(updated?.status).toBe('sent');
  });

  it('does not approve the same draft twice', async () => {
    const harness = createHarness();
    await harness.app.handleWebhook(harness.webhook(samplePayload()));
    const draftId = (await harness.app.repository.listDrafts())[0]?.id as string;

    await handleAdminRequest(
      harness.app,
      adminRequest(`/drafts/${draftId}/approve`, { method: 'POST', body: {} }),
      `drafts/${draftId}/approve`,
    );
    const second = await handleAdminRequest(
      harness.app,
      adminRequest(`/drafts/${draftId}/approve`, { method: 'POST', body: {} }),
      `drafts/${draftId}/approve`,
    );

    expect(second.status).toBe(409);
    expect(harness.calls.deomail.filter((call) => call.url.includes('/v1/send'))).toHaveLength(1);
  });

  it('rejects a draft', async () => {
    const harness = createHarness();
    await harness.app.handleWebhook(harness.webhook(samplePayload()));
    const draftId = (await harness.app.repository.listDrafts())[0]?.id as string;

    const response = await handleAdminRequest(
      harness.app,
      adminRequest(`/drafts/${draftId}/reject`, { method: 'POST', body: {} }),
      `drafts/${draftId}/reject`,
    );
    expect(response.status).toBe(200);
    expect((await harness.app.repository.getDraft(draftId))?.status).toBe('rejected');
    expect(harness.calls.deomail.filter((call) => call.url.includes('/v1/send'))).toHaveLength(0);
  });

  it('changes the operating mode and the system prompt', async () => {
    const harness = createHarness();
    const response = await handleAdminRequest(
      harness.app,
      adminRequest('/settings', {
        method: 'POST',
        body: { mode: 'automatic', systemPrompt: 'You are a pirate. Answer briefly.' },
      }),
      'settings',
    );
    expect(response.status).toBe(200);

    const settings = await harness.app.resolveSettings();
    expect(settings.mode).toBe('automatic');
    expect(settings.systemPrompt).toContain('pirate');

    // The new mode is applied to the next inbound email.
    const webhook = await harness.app.handleWebhook(harness.webhook(samplePayload({ message_id: 'after-settings' })));
    expect((await readJson<{ status: string }>(webhook)).status).toBe('sent');
  });

  it('disables automation from the dashboard', async () => {
    const harness = createHarness();
    await handleAdminRequest(harness.app, adminRequest('/settings', { method: 'POST', body: { enabled: false } }), 'settings');
    const response = await harness.app.handleWebhook(harness.webhook(samplePayload()));
    expect((await readJson<{ status: string }>(response)).status).toBe('disabled');
  });

  it('records activity for the dashboard', async () => {
    const harness = createHarness();
    await harness.app.handleWebhook(harness.webhook(samplePayload()));
    const response = await handleAdminRequest(harness.app, adminRequest('/activity'), 'activity');
    const body = await readJson<{ activity: Array<{ event: string }> }>(response);
    expect(body.activity.length).toBeGreaterThan(0);
    expect(body.activity.some((entry) => entry.event === 'draft.created')).toBe(true);
  });

  it('rate limits abusive admin clients', async () => {
    const harness = createHarness({ env: { ADMIN_RATE_LIMIT_PER_MINUTE: 2 } });
    const first = await handleAdminRequest(harness.app, adminRequest('/stats'), 'stats');
    const second = await handleAdminRequest(harness.app, adminRequest('/stats'), 'stats');
    const third = await handleAdminRequest(harness.app, adminRequest('/stats'), 'stats');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
  });
});
