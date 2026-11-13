import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../lib/security';
import type { AppSettings, Draft, RateLimitDecision, UsageStats } from '../types';
import type { Storage } from './storage';

const DONE_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days
const LOCK_TTL_SECONDS = 180; // 3 minutes
const FAIL_TTL_SECONDS = 60 * 60 * 24;
const STAT_TTL_SECONDS = 60 * 60 * 24 * 400;
const DRAFT_INDEX_LIMIT = 500;
const ACTIVITY_LIMIT = 250;

export interface EventClaim {
  status: 'claimed' | 'duplicate' | 'in_progress';
  lockToken?: string;
  previousState?: string;
}

export interface DraftTransition {
  ok: boolean;
  reason?: 'not_found' | 'locked' | 'invalid_state';
  draft?: Draft;
}

/** Typed accessors on top of the raw storage primitives. */
export class Repository {
  constructor(private readonly storage: Storage) {}

  get raw(): Storage {
    return this.storage;
  }

  // ---------------------------------------------------------------- events --

  /** Atomically claim an inbound message for processing. */
  async claimEvent(emailKey: string): Promise<EventClaim> {
    const doneKey = `event:${emailKey}:done`;
    const done = await this.storage.get(doneKey);
    if (done) {
      let previousState = 'processed';
      try {
        previousState = (JSON.parse(done) as { state?: string }).state ?? 'processed';
      } catch {
        /* keep default */
      }
      return { status: 'duplicate', previousState };
    }

    const lockToken = randomUUID();
    const acquired = await this.storage.set(`event:${emailKey}:lock`, lockToken, {
      nx: true,
      ttlSeconds: LOCK_TTL_SECONDS,
    });
    if (!acquired) return { status: 'in_progress' };
    return { status: 'claimed', lockToken };
  }

  /** Mark an event as terminally handled. */
  async completeEvent(emailKey: string, payload: Record<string, unknown>): Promise<void> {
    await this.storage.set(`event:${emailKey}:done`, JSON.stringify(payload), { ttlSeconds: DONE_TTL_SECONDS });
    await this.storage.del(`event:${emailKey}:lock`);
  }

  /** Release the processing lock and remember the failure (allows a retry). */
  async releaseEvent(emailKey: string, lockToken: string, error: { code?: string; message?: string }): Promise<void> {
    const failKey = `event:${emailKey}:fail`;
    const current = await this.storage.get(failKey);
    let attempts = 1;
    if (current) {
      try {
        attempts = Number((JSON.parse(current) as { attempts?: number }).attempts ?? 0) + 1;
      } catch {
        attempts = 1;
      }
    }
    await this.storage.set(
      failKey,
      JSON.stringify({ attempts, code: error.code, message: error.message, at: new Date().toISOString() }),
      { ttlSeconds: FAIL_TTL_SECONDS },
    );
    await this.storage.del(`event:${emailKey}:lock`);
    void lockToken;
  }

  async eventFailure(emailKey: string): Promise<{ attempts: number; code?: string; message?: string } | null> {
    const raw = await this.storage.get(`event:${emailKey}:fail`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as { attempts: number; code?: string; message?: string };
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------ rate limits --

  /**
   * Reserve one reply slot. Returns whether the reply may be produced.
   * Slots are reserved atomically so parallel function instances share the budget.
   */
  async reserveReplyQuota(
    sender: string,
    options: { maxPerDay: number; maxPerSenderPerDay: number },
  ): Promise<RateLimitDecision> {
    const date = new Date().toISOString().slice(0, 10);
    const ttl = secondsUntilUtcMidnight();

    const globalKey = `ratelimit:global:${date}`;
    const senderKey = `ratelimit:sender:${sha256Hex(sender.toLowerCase()).slice(0, 32)}:${date}`;

    const globalCount = await this.storage.incr(globalKey, ttl);
    if (globalCount > options.maxPerDay) {
      await this.storage.decrement(globalKey);
      return { allowed: false, reason: 'daily_limit', globalCount };
    }

    const senderCount = await this.storage.incr(senderKey, ttl);
    if (senderCount > options.maxPerSenderPerDay) {
      await this.storage.decrement(senderKey);
      await this.storage.decrement(globalKey);
      return { allowed: false, reason: 'sender_limit', globalCount, senderCount };
    }

    return { allowed: true, globalCount, senderCount };
  }

  /**
   * Count one automatic reply for a conversation.
   * Used before an automatic send so a thread never receives an endless
   * stream of answers. Manual approvals are a human decision and are not
   * limited by this counter.
   */
  async claimConversationReply(
    conversationKey: string,
    maxReplies: number,
  ): Promise<{ allowed: boolean; count: number }> {
    const key = `conv:${sha256Hex(conversationKey).slice(0, 32)}:replies`;
    const count = await this.storage.incr(key, DONE_TTL_SECONDS);
    return { allowed: count <= maxReplies, count };
  }

  /** Give a reserved slot back (used when the reply could not be produced). */
  async releaseReplyQuota(sender: string): Promise<void> {
    const date = new Date().toISOString().slice(0, 10);
    await this.storage.decrement(`ratelimit:global:${date}`);
    await this.storage.decrement(`ratelimit:sender:${sha256Hex(sender.toLowerCase()).slice(0, 32)}:${date}`);
  }

  // ----------------------------------------------------------------- stats --

  async incrementStat(name: string): Promise<void> {
    const date = new Date().toISOString().slice(0, 10);
    await this.storage.incr(`stat:${name}`, STAT_TTL_SECONDS);
    await this.storage.incr(`stat:${name}:${date}`, STAT_TTL_SECONDS);
  }

  async getStats(): Promise<UsageStats> {
    const read = async (name: string): Promise<number> => {
      const raw = await this.storage.get(`stat:${name}`);
      const value = Number(raw ?? '0');
      return Number.isFinite(value) ? value : 0;
    };
    const [processed, repliesGenerated, repliesSent, failed, skipped, duplicates, escalations] = await Promise.all([
      read('processed'),
      read('replies_generated'),
      read('replies_sent'),
      read('failed'),
      read('skipped'),
      read('duplicates'),
      read('escalations'),
    ]);
    return {
      processed,
      repliesGenerated,
      repliesSent,
      failed,
      skipped,
      duplicates,
      escalations,
      draftsPending: await this.countDrafts('pending') + await this.countDrafts('escalated'),
    };
  }

  async getDailyStats(date: string): Promise<UsageStats> {
    const read = async (name: string): Promise<number> => {
      const raw = await this.storage.get(`stat:${name}:${date}`);
      const value = Number(raw ?? '0');
      return Number.isFinite(value) ? value : 0;
    };
    const [processed, repliesGenerated, repliesSent, failed, skipped, duplicates, escalations] = await Promise.all([
      read('processed'),
      read('replies_generated'),
      read('replies_sent'),
      read('failed'),
      read('skipped'),
      read('duplicates'),
      read('escalations'),
    ]);
    return {
      processed,
      repliesGenerated,
      repliesSent,
      failed,
      skipped,
      duplicates,
      escalations,
      draftsPending: await this.countDrafts('pending') + await this.countDrafts('escalated'),
    };
  }

  // -------------------------------------------------------------- activity --

  async recordActivity(entry: Record<string, unknown>): Promise<void> {
    const id = randomUUID();
    const payload = { id, ts: new Date().toISOString(), ...entry };
    await this.storage.lpush('activity', JSON.stringify(payload), ACTIVITY_LIMIT);
  }

  async listActivity(limit = 50): Promise<Record<string, unknown>[]> {
    const raw = await this.storage.lrange('activity', 0, Math.max(0, limit - 1));
    const entries: Record<string, unknown>[] = [];
    for (const item of raw) {
      try {
        entries.push(JSON.parse(item) as Record<string, unknown>);
      } catch {
        /* skip malformed */
      }
    }
    return entries;
  }

  // --------------------------------------------------------------- drafts --

  async saveDraft(draft: Draft): Promise<void> {
    await this.storage.set(`draft:${draft.id}`, JSON.stringify(draft));
    await this.storage.lpush('drafts:index', draft.id, DRAFT_INDEX_LIMIT);
  }

  async getDraft(id: string): Promise<Draft | null> {
    const raw = await this.storage.get(`draft:${id}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Draft;
    } catch {
      return null;
    }
  }

  async listDrafts(status?: Draft['status'], limit = 50): Promise<Draft[]> {
    const ids = await this.storage.lrange('drafts:index', 0, Math.max(0, limit * 4 - 1));
    const drafts: Draft[] = [];
    for (const id of ids) {
      const draft = await this.getDraft(id);
      if (!draft) continue;
      if (status && draft.status !== status) continue;
      drafts.push(draft);
      if (drafts.length >= limit) break;
    }
    return drafts;
  }

  async countDrafts(status: Draft['status']): Promise<number> {
    const ids = await this.storage.lrange('drafts:index', 0, DRAFT_INDEX_LIMIT - 1);
    let count = 0;
    for (const id of ids) {
      const draft = await this.getDraft(id);
      if (draft && draft.status === status) count += 1;
    }
    return count;
  }

  /**
   * Atomically move a draft between states.
   * A short lived lock keeps concurrent approvals from double sending.
   */
  async transitionDraft(
    id: string,
    from: Draft['status'][],
    to: Draft['status'],
    patch: Partial<Draft> = {},
  ): Promise<DraftTransition> {
    const lockToken = randomUUID();
    const acquired = await this.storage.set(`lock:draft:${id}`, lockToken, { nx: true, ttlSeconds: 15 });
    if (!acquired) return { ok: false, reason: 'locked' };

    try {
      const draft = await this.getDraft(id);
      if (!draft) return { ok: false, reason: 'not_found' };
      if (from.length > 0 && !from.includes(draft.status)) {
        return { ok: false, reason: 'invalid_state', draft };
      }
      const updated: Draft = {
        ...draft,
        ...patch,
        status: to,
        updatedAt: new Date().toISOString(),
      };
      await this.storage.set(`draft:${id}`, JSON.stringify(updated));
      return { ok: true, draft: updated };
    } finally {
      await this.storage.del(`lock:draft:${id}`);
    }
  }

  // ------------------------------------------------------------- settings --

  async getSettings(): Promise<AppSettings | null> {
    const raw = await this.storage.get('settings');
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AppSettings;
    } catch {
      return null;
    }
  }

  async saveSettings(settings: AppSettings): Promise<void> {
    await this.storage.set('settings', JSON.stringify(settings));
  }
}

function secondsUntilUtcMidnight(): number {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
  return Math.max(60, Math.floor((midnight - now.getTime()) / 1000));
}
