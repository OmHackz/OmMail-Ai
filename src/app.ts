import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AgnesClient } from './ai/agnes';
import {
  buildSystemPrompt,
  buildUserPrompt,
  DEFAULT_SIGNATURE,
  detectInjectionWithSensitivity,
  sanitizeAiReply,
} from './ai/prompts';
import { Repository } from './db/repositories';
import { MemoryStorage } from './db/memory';
import { RedisRestStorage } from './db/redis';
import type { Storage } from './db/storage';
import { DeoMailClient } from './email/deomail';
import { evaluateEmail } from './email/filters';
import { composeReplyBody, composeReplyHtml } from './email/reply';
import { escalationRecipients, getEnv, selfAddresses, selfDomains } from './lib/env';
import type { Env } from './lib/env';
import { AppError, toAppError } from './lib/errors';
import { jsonResponse, readBodyLimited } from './lib/http';
import { createLogger } from './lib/logger';
import type { Logger } from './lib/logger';
import { randomRequestId, sha256Hex } from './lib/security';
import { buildReplySubject, conversationKey, detectLanguage, truncate } from './lib/text';
import type { AppSettings, Draft, IncomingEmail, ProcessingState } from './types';
import { resolveProfile } from './webhook/adapter';
import type { WebhookProfile } from './webhook/adapter';
import { parseFireEvent } from './webhook/handler';

export interface AppDependencies {
  env: Env;
  storage: Storage;
  deomail: DeoMailClient;
  agnes: AgnesClient;
  logger: Logger;
  webhookProfile?: WebhookProfile;
  now?: () => Date;
}

export interface WebhookOutcome {
  state: ProcessingState;
  detail?: string;
  draftId?: string;
  escalated?: boolean;
}

const SETTINGS_SCHEMA = z.object({
  mode: z.enum(['draft', 'automatic', 'disabled']),
  enabled: z.boolean(),
  systemPrompt: z.string().max(20000).optional(),
  signature: z.string().max(2000).optional(),
});

/**
 * OmMail AI application core.
 *
 * Everything that a request handler needs is injected, which keeps the code
 * testable and lets the API functions stay thin wrappers.
 */
export class App {
  readonly env: Env;
  readonly storage: Storage;
  readonly repository: Repository;
  readonly deomail: DeoMailClient;
  readonly agnes: AgnesClient;
  readonly logger: Logger;
  readonly webhookProfile: WebhookProfile;
  private readonly now: () => Date;

  constructor(deps: AppDependencies) {
    this.env = deps.env;
    this.storage = deps.storage;
    this.repository = new Repository(deps.storage);
    this.deomail = deps.deomail;
    this.agnes = deps.agnes;
    this.logger = deps.logger;
    this.webhookProfile = deps.webhookProfile ?? resolveProfile(this.env.DEOMAIL_WEBHOOK_PROFILE);
    this.now = deps.now ?? (() => new Date());
  }

  /** Build an app from the environment (used by the Vercel functions). */
  static create(overrides: Partial<AppDependencies> = {}): App {
    const env = overrides.env ?? getEnv();
    const storage =
      overrides.storage ??
      (env.STORAGE_PROVIDER === 'memory'
        ? new MemoryStorage()
        : new RedisRestStorage({
            url: env.UPSTASH_REDIS_REST_URL as string,
            token: env.UPSTASH_REDIS_REST_TOKEN as string,
            prefix: env.REDIS_PREFIX,
          }));

    const deomail =
      overrides.deomail ??
      new DeoMailClient({
        apiKey: env.DEOMAIL_API_KEY,
        baseUrl: env.DEOMAIL_BASE_URL,
        timeoutMs: 15000,
        maxRetries: env.MAX_RETRIES,
      });

    const agnes =
      overrides.agnes ??
      new AgnesClient({
        apiKey: env.AGNES_API_KEY,
        baseUrl: env.AGNES_BASE_URL,
        model: env.AGNES_MODEL,
        temperature: env.AGNES_TEMPERATURE,
        maxTokens: env.AGNES_MAX_TOKENS,
        timeoutMs: env.AGNES_TIMEOUT_MS,
        maxRetries: env.AGNES_MAX_RETRIES,
      });

    const logger =
      overrides.logger ??
      createLogger({ level: env.LOG_LEVEL, base: { app: env.APP_NAME, version: env.APP_VERSION } });

    return new App({ env, storage, deomail, agnes, logger, ...overrides });
  }

  // ------------------------------------------------------------- settings --

  /** Effective settings: environment defaults, overridden by stored settings. */
  async resolveSettings(): Promise<AppSettings> {
    const defaults: AppSettings = {
      mode: this.env.AUTO_REPLY_MODE,
      enabled: true,
      systemPrompt: this.env.AI_SYSTEM_PROMPT || undefined,
      signature: this.env.REPLY_SIGNATURE || DEFAULT_SIGNATURE,
      updatedAt: this.now().toISOString(),
    };
    const stored = await this.repository.getSettings();
    if (!stored) return defaults;
    return { ...defaults, ...stored };
  }

  async updateSettings(patch: unknown): Promise<AppSettings> {
    const parsed = SETTINGS_SCHEMA.partial().parse(patch);
    const current = await this.resolveSettings();
    const next: AppSettings = {
      ...current,
      ...parsed,
      updatedAt: this.now().toISOString(),
      updatedBy: 'admin',
    };
    await this.repository.saveSettings(next);
    return next;
  }

  // -------------------------------------------------------------- webhook --

  async handleWebhook(request: Request): Promise<Response> {
    const requestId = randomRequestId();
    const logger = this.logger.child({ requestId });
    const startedAt = Date.now();

    if (request.method !== 'POST') {
      return jsonResponse({ ok: false, error: 'method_not_allowed' }, { status: 405 });
    }

    let rawBody: string;
    try {
      rawBody = await readBodyLimited(request, this.env.MAX_WEBHOOK_BYTES);
    } catch (error) {
      const appError = toAppError(error);
      logger.warn('webhook.payload_rejected', { errorCategory: appError.category, errorCode: appError.code });
      return jsonResponse({ ok: false, error: appError.code }, { status: appError.status });
    }

    const event = parseFireEvent(this, request, rawBody);
    if (!event.ok) {
      if (event.status === 401) {
        logger.warn('webhook.auth_failed', { errorCategory: 'auth', errorCode: 'invalid_webhook_secret' });
        await this.repository.recordActivity({
          event: 'webhook.auth_failed',
          errorCategory: 'auth',
          errorCode: 'invalid_webhook_secret',
          requestId,
        });
      } else {
        logger.warn('webhook.invalid_event', { errorCategory: 'validation', errorCode: event.body.error });
        await this.repository.recordActivity({
          event: 'webhook.invalid_event',
          errorCategory: 'validation',
          errorCode: String(event.body.error),
          requestId,
        });
      }
      return jsonResponse(event.body, { status: event.status });
    }

    const settings = await this.resolveSettings();

    if (settings.mode === 'disabled' || !settings.enabled) {
      logger.info('webhook.disabled_mode');
      await this.repository.recordActivity({ event: 'webhook.disabled', requestId });
      return jsonResponse({ ok: true, status: 'disabled', requestId });
    }

    const email = event.parsed.email;
    const emailKey = sha256Hex(email.providerId).slice(0, 40);

    const claim = await this.repository.claimEvent(emailKey);
    if (claim.status === 'duplicate') {
      logger.info('webhook.duplicate', { emailId: email.providerId, state: 'duplicate' });
      await this.repository.incrementStat('duplicates');
      return jsonResponse({ ok: true, status: 'duplicate', requestId });
    }
    if (claim.status === 'in_progress') {
      logger.info('webhook.in_progress', { emailId: email.providerId });
      return jsonResponse({ ok: true, status: 'in_progress', requestId });
    }

    try {
      const outcome = await this.processEmail(email, settings, logger, requestId);
      await this.repository.completeEvent(emailKey, {
        state: outcome.state,
        detail: outcome.detail,
        at: this.now().toISOString(),
      });
      logger.info('webhook.completed', {
        emailId: email.providerId,
        state: outcome.state,
        durationMs: Date.now() - startedAt,
      });
      return jsonResponse(
        {
          ok: true,
          status: outcome.state,
          detail: outcome.detail,
          draftId: outcome.draftId,
          escalated: outcome.escalated ?? false,
          requestId,
        },
        { status: 200 },
      );
    } catch (error) {
      const appError = toAppError(error);
      const durationMs = Date.now() - startedAt;
      logger.error('webhook.failed', {
        emailId: email.providerId,
        errorCategory: appError.category,
        errorCode: appError.code,
        deliveryUnknown: appError.deliveryUnknown,
        durationMs,
      });
      await this.repository.incrementStat('failed');
      await this.repository.recordActivity({
        event: 'webhook.failed',
        state: 'failed',
        emailId: email.providerId,
        errorCategory: appError.category,
        errorCode: appError.code,
        durationMs,
        requestId,
      });

      // A retryable failure keeps the event open so a later delivery can retry.
      // An ambiguous delivery result is terminal: the message may have been sent.
      if (appError.retryable && !appError.deliveryUnknown) {
        await this.repository.releaseEvent(emailKey, claim.lockToken ?? '', {
          code: appError.code,
          message: appError.message,
        });
        return jsonResponse(
          { ok: false, status: 'failed', retryable: true, error: appError.code, requestId },
          { status: 200 },
        );
      }

      await this.repository.completeEvent(emailKey, {
        state: appError.deliveryUnknown ? 'send_uncertain' : 'failed',
        errorCode: appError.code,
        at: this.now().toISOString(),
      });
      return jsonResponse(
        { ok: false, status: appError.deliveryUnknown ? 'send_uncertain' : 'failed', error: appError.code, requestId },
        { status: 200 },
      );
    }
  }

  // ------------------------------------------------------------- pipeline --

  private async processEmail(
    incoming: IncomingEmail,
    settings: AppSettings,
    logger: Logger,
    requestId: string,
  ): Promise<WebhookOutcome> {
    await this.repository.incrementStat('processed');

    // Injection scanning runs on the raw webhook body *and* on the enriched
    // body: either one is enough to escalate the message.
    const previewInjection = detectInjectionWithSensitivity(
      `${incoming.subject}\n${incoming.bodyText}`,
      this.env.INJECTION_SENSITIVITY,
    );

    const email = await this.enrichEmail(incoming, logger);
    const bodyText = truncate(email.bodyText ?? '', this.env.MAX_EMAIL_BODY_CHARS);

    const bodyInjection = detectInjectionWithSensitivity(
      `${email.subject}\n${bodyText}`,
      this.env.INJECTION_SENSITIVITY,
    );
    const injection = previewInjection.detected ? previewInjection : bodyInjection;

    const filter = evaluateEmail({
      email: { ...email, bodyText },
      selfDomains: selfDomains(this.env),
      selfAddresses: selfAddresses(this.env),
      spamScoreThreshold: this.env.SPAM_SCORE_THRESHOLD ?? undefined,
      spamScoreMax: this.env.SPAM_SCORE_MAX ?? undefined,
      injectionDetected: injection.detected,
      injectionFindings: injection.findings.map((finding) => finding.pattern),
      additionalSubjects: incoming.subject !== email.subject ? [incoming.subject] : [],
    });

    if (!filter.eligible) {
      await this.repository.incrementStat('skipped');
      await this.repository.recordActivity({
        event: 'email.skipped',
        state: 'skipped',
        emailId: email.providerId,
        sender: email.fromEmail,
        subject: email.subject,
        detail: filter.reason,
        requestId,
      });
      logger.info('email.skipped', { emailId: email.providerId, reason: filter.reason });
      return { state: 'skipped', detail: filter.reason };
    }

    const conversation = conversationKey(email.fromEmail, email.subject);
    const quota = await this.repository.reserveReplyQuota(email.fromEmail, {
      maxPerDay: this.env.MAX_REPLIES_PER_DAY,
      maxPerSenderPerDay: this.env.MAX_REPLIES_PER_SENDER_DAY,
    });

    if (!quota.allowed) {
      await this.repository.incrementStat('skipped');
      await this.repository.recordActivity({
        event: 'email.rate_limited',
        state: 'skipped',
        emailId: email.providerId,
        sender: email.fromEmail,
        subject: email.subject,
        detail: quota.reason,
        requestId,
      });
      logger.info('email.rate_limited', { emailId: email.providerId, reason: quota.reason });
      return { state: 'skipped', detail: quota.reason };
    }

    const language = detectLanguage(`${email.subject}\n${bodyText}`);
    const signature = settings.signature || DEFAULT_SIGNATURE;
    const mode: 'draft' | 'automatic' = settings.mode === 'automatic' ? 'automatic' : 'draft';

    const systemPrompt = buildSystemPrompt(settings.systemPrompt, {
      email: { ...email, bodyText },
      signature,
      mode,
      language,
    });
    const userPrompt = buildUserPrompt({ email: { ...email, bodyText }, mode });

    let completion;
    try {
      completion = await this.agnes.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ]);
    } catch (error) {
      // The reply was never produced — give the reserved quota slot back.
      await this.repository.releaseReplyQuota(email.fromEmail);
      throw error;
    }

    await this.repository.incrementStat('replies_generated');

    const sanitized = sanitizeAiReply(completion.content, {
      signature,
      maxChars: this.env.MAX_AI_RESPONSE_CHARS,
    });

    if (!sanitized.text) {
      await this.repository.releaseReplyQuota(email.fromEmail);
      throw new AppError('The AI did not return a usable reply', {
        category: 'upstream',
        code: 'AI_EMPTY_REPLY',
        status: 502,
        retryable: true,
      });
    }

    if (sanitized.issues.includes('possible_prompt_leak')) {
      filter.escalate = true;
      filter.reason = 'prompt_injection';
      filter.detail = 'model_output_contained_instructions';
    }

    const subject = buildReplySubject(email.subject);
    const body = composeReplyBody(sanitized.text, signature);
    const html = composeReplyHtml(sanitized.text, signature);

    const draft: Draft = {
      id: randomUUID(),
      emailId: email.providerId,
      from: email.fromEmail,
      to: email.fromEmail,
      subject,
      text: body,
      html,
      status: filter.escalate ? 'escalated' : 'pending',
      reason: filter.escalate ? filter.reason : undefined,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      source: 'webhook',
      language,
    };

    if (mode === 'draft' || filter.escalate) {
      await this.repository.saveDraft(draft);
      await this.repository.recordActivity({
        event: filter.escalate ? 'draft.escalated' : 'draft.created',
        state: filter.escalate ? 'escalated' : 'draft_created',
        emailId: email.providerId,
        sender: email.fromEmail,
        subject: email.subject,
        detail: filter.escalate ? filter.reason : undefined,
        escalateTo: filter.escalate ? escalationRecipients(this.env) : undefined,
        requestId,
      });
      if (filter.escalate) await this.repository.incrementStat('escalations');
      logger.info('draft.created', {
        emailId: email.providerId,
        draftId: draft.id,
        escalated: filter.escalate,
        escalateTo: filter.escalate ? escalationRecipients(this.env) : undefined,
      });
      return {
        state: filter.escalate ? 'escalated' : 'draft_created',
        draftId: draft.id,
        escalated: filter.escalate,
        detail: filter.escalate ? filter.reason : undefined,
      };
    }

    // Automatic mode — record the draft first (audit trail), then send it.
    await this.repository.saveDraft(draft);

    if (!this.env.ALLOW_MULTIPLE_REPLIES_PER_CONVERSATION) {
      const conversationClaim = await this.repository.claimConversationReply(
        conversation,
        this.env.MAX_CONVERSATION_REPLIES,
      );
      if (!conversationClaim.allowed) {
        const escalated = await this.repository.transitionDraft(draft.id, ['pending'], 'escalated', {
          reason: 'conversation_limit',
        });
        await this.repository.incrementStat('escalations');
        await this.repository.recordActivity({
          event: 'draft.escalated',
          state: 'escalated',
          emailId: email.providerId,
          sender: email.fromEmail,
          subject: email.subject,
          detail: 'conversation_limit',
          requestId,
        });
        logger.info('reply.conversation_limit', {
          emailId: email.providerId,
          count: conversationClaim.count,
        });
        return {
          state: 'escalated',
          draftId: escalated.draft?.id ?? draft.id,
          escalated: true,
          detail: 'conversation_limit',
        };
      }
    }

    return this.sendReply(
      {
        to: email.fromEmail,
        subject,
        body,
        html,
        emailId: email.providerId,
        draft,
      },
      logger,
    );
  }

  /**
   * Fetch the complete email from DeoMail when the webhook only carried a
   * preview. Failures are non fatal: the preview is used instead.
   */
  private async enrichEmail(email: IncomingEmail, logger: Logger): Promise<IncomingEmail> {
    const needsFetch = email.bodyIsPreview || !email.bodyText.trim();
    if (!needsFetch || email.providerId.startsWith('sha256:')) return email;

    try {
      const full = await this.deomail.getEmail(email.providerId);
      if (!full) {
        logger.warn('email.fetch_missing', { emailId: email.providerId });
        return email;
      }
      return {
        ...email,
        from: full.from || email.from,
        fromEmail: email.fromEmail,
        to: full.to.length ? full.to : email.to,
        subject: full.subject || email.subject,
        bodyText: full.bodyText?.trim() ? full.bodyText : email.bodyText,
        bodyHtml: full.bodyHtml?.trim() ? full.bodyHtml : email.bodyHtml,
        headers: { ...full.headers, ...email.headers },
        receivedAt: full.receivedAt ?? email.receivedAt,
        hasAttachments: full.hasAttachments,
        attachmentCount: email.attachmentCount || (full.hasAttachments ? 1 : 0),
        bodyFromApi: true,
        bodyIsPreview: false,
      };
    } catch (error) {
      const appError = toAppError(error);
      logger.warn('email.fetch_failed', {
        emailId: email.providerId,
        errorCategory: appError.category,
        errorCode: appError.code,
      });
      return email;
    }
  }

  /** Send a reply through the DeoMail REST API (idempotent per email). */
  private async sendReply(
    input: { to: string; subject: string; body: string; html: string; emailId: string; draft?: Draft },
    logger: Logger,
  ): Promise<WebhookOutcome> {
    const emailKey = sha256Hex(input.emailId).slice(0, 40);
    const sendLockKey = `event:${emailKey}:sendlock`;

    const acquired = await this.storage.set(sendLockKey, randomUUID(), { nx: true, ttlSeconds: 300 });
    if (!acquired) {
      logger.warn('reply.send_in_progress', { emailId: input.emailId });
      return { state: 'skipped', detail: 'send_in_progress' };
    }

    try {
      const alreadySent = await this.storage.get(`event:${emailKey}:sent`);
      if (alreadySent) {
        logger.info('reply.already_sent', { emailId: input.emailId });
        return { state: 'sent', detail: 'already_sent' };
      }

      const result = await this.deomail.sendEmail({
        from: this.env.DEOMAIL_SENDER,
        to: [input.to],
        subject: input.subject,
        text: input.body,
        html: input.html,
      });

      await this.storage.set(
        `event:${emailKey}:sent`,
        JSON.stringify({ messageId: result.messageId, at: this.now().toISOString() }),
        { ttlSeconds: 60 * 60 * 24 * 90 },
      );
      await this.repository.incrementStat('replies_sent');

      if (input.draft) {
        await this.repository.transitionDraft(input.draft.id, ['pending', 'escalated', 'approved'], 'sent', {
          sentAt: this.now().toISOString(),
          deomailMessageId: result.messageId,
        });
      }

      await this.repository.recordActivity({
        event: 'reply.sent',
        state: 'sent',
        emailId: input.emailId,
        sender: input.to,
        subject: input.subject,
        requestId: undefined,
      });
      logger.info('reply.sent', { emailId: input.emailId, messageId: result.messageId });
      return { state: 'sent', draftId: input.draft?.id };
    } catch (error) {
      const appError = toAppError(error);
      if (input.draft) {
        await this.repository.transitionDraft(input.draft.id, ['pending', 'escalated', 'approved'], 'failed', {
          error: appError.message,
        });
      }
      if (appError.deliveryUnknown) {
        // The message may already have been delivered. Keep the lock so nobody
        // retries the send automatically, and escalate for a human to check.
        await this.storage.set(
          `event:${emailKey}:sendlock`,
          JSON.stringify({ uncertain: true, at: this.now().toISOString() }),
          { ttlSeconds: 60 * 60 * 24 * 90 },
        );
        logger.error('reply.send_uncertain', {
          emailId: input.emailId,
          errorCategory: appError.category,
          errorCode: appError.code,
        });
        await this.repository.recordActivity({
          event: 'reply.send_uncertain',
          state: 'send_uncertain',
          emailId: input.emailId,
          errorCategory: appError.category,
          errorCode: appError.code,
        });
      }
      throw appError;
    } finally {
      const current = await this.storage.get(sendLockKey);
      if (!current || !current.includes('uncertain')) {
        await this.storage.del(sendLockKey);
      }
    }
  }

  // ---------------------------------------------------------------- admin --

  /** Approve a draft and send it. */
  async approveDraft(id: string, options: { text?: string; subject?: string; send?: boolean } = {}): Promise<Draft> {
    const draft = await this.repository.getDraft(id);
    if (!draft) {
      throw new AppError('Draft not found', { category: 'validation', code: 'DRAFT_NOT_FOUND', status: 404 });
    }

    const transition = await this.repository.transitionDraft(id, ['pending', 'escalated'], 'approved', {
      text: options.text ? composeReplyBody(options.text, (await this.resolveSettings()).signature || DEFAULT_SIGNATURE) : draft.text,
      subject: options.subject ?? draft.subject,
    });

    if (!transition.ok || !transition.draft) {
      throw new AppError(
        transition.reason === 'invalid_state' ? 'Draft is not in an approvable state' : 'Draft is locked by another request',
        {
          category: transition.reason === 'invalid_state' ? 'validation' : 'duplicate',
          code: `DRAFT_${String(transition.reason ?? 'FAILED').toUpperCase()}`,
          status: transition.reason === 'invalid_state' ? 409 : 409,
        },
      );
    }

    const approved = transition.draft;

    if (options.send === false) {
      await this.repository.transitionDraft(id, ['approved'], 'pending');
      return { ...approved, status: 'pending' };
    }

    try {
      await this.sendReply(
        {
          to: approved.to,
          subject: approved.subject,
          body: approved.text,
          html: approved.html ?? composeReplyHtml(approved.text),
          emailId: approved.emailId,
          draft: approved,
        },
        this.logger,
      );
      const updated = await this.repository.getDraft(id);
      return updated ?? { ...approved, status: 'sent' };
    } catch (error) {
      const appError = toAppError(error);
      await this.repository.transitionDraft(id, ['approved'], 'failed', { error: appError.message });
      throw appError;
    }
  }

  /** Reject a draft without sending it. */
  async rejectDraft(id: string, reason?: string): Promise<Draft> {
    const transition = await this.repository.transitionDraft(id, ['pending', 'escalated', 'approved'], 'rejected', {
      reason: reason ?? 'rejected by administrator',
    });
    if (!transition.ok || !transition.draft) {
      throw new AppError('Draft cannot be rejected in its current state', {
        category: 'validation',
        code: 'DRAFT_INVALID_STATE',
        status: 409,
      });
    }
    return transition.draft;
  }

  /** Regenerate the AI reply for a draft. */
  async regenerateDraft(id: string): Promise<Draft> {
    const draft = await this.repository.getDraft(id);
    if (!draft) {
      throw new AppError('Draft not found', { category: 'validation', code: 'DRAFT_NOT_FOUND', status: 404 });
    }

    const settings = await this.resolveSettings();
    const signature = settings.signature || DEFAULT_SIGNATURE;
    const email: IncomingEmail = {
      providerId: draft.emailId,
      from: draft.from,
      fromEmail: draft.from,
      to: [draft.from],
      subject: draft.subject,
      bodyText: draft.text,
      headers: {},
      attachmentCount: 0,
      bodyFromApi: false,
      bodyIsPreview: false,
      rawPayload: null,
    };

    const completion = await this.agnes.chat([
      { role: 'system', content: buildSystemPrompt(settings.systemPrompt, { email, signature, mode: 'draft' }) },
      { role: 'user', content: buildUserPrompt({ email, mode: 'draft' }) },
    ]);
    const sanitized = sanitizeAiReply(completion.content, { signature, maxChars: this.env.MAX_AI_RESPONSE_CHARS });

    const transition = await this.repository.transitionDraft(id, ['pending', 'escalated', 'failed'], 'pending', {
      text: composeReplyBody(sanitized.text, signature),
      html: composeReplyHtml(sanitized.text, signature),
    });
    if (!transition.ok || !transition.draft) {
      throw new AppError('Draft cannot be regenerated in its current state', {
        category: 'validation',
        code: 'DRAFT_INVALID_STATE',
        status: 409,
      });
    }
    return transition.draft;
  }

  /** Create a draft by hand (useful for testing the sending path). */
  async createManualDraft(input: { to: string; subject: string; text: string }): Promise<Draft> {
    const signature = (await this.resolveSettings()).signature || DEFAULT_SIGNATURE;
    const draft: Draft = {
      id: randomUUID(),
      emailId: `manual:${randomUUID()}`,
      from: this.env.DEOMAIL_SENDER,
      to: input.to,
      subject: input.subject,
      text: composeReplyBody(input.text, signature),
      html: composeReplyHtml(input.text, signature),
      status: 'pending',
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      source: 'manual',
    };
    await this.repository.saveDraft(draft);
    return draft;
  }
}
