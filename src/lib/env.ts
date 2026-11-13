import { z } from 'zod';
import { ConfigError } from './errors';

/**
 * Environment configuration for OmMail AI.
 *
 * Everything the application needs is validated here, on the server, with Zod.
 * Secrets are never returned to a client and never logged.
 */

const emptyToUndef = (value: unknown): unknown =>
  value === '' || value === null ? undefined : value;

const bool = (fallback: boolean) =>
  z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    return ['1', 'true', 'yes', 'on', 'enabled'].includes(normalized);
  }, z.boolean());

const int = (fallback: number, min: number, max: number) =>
  z.preprocess(emptyToUndef, z.coerce.number().int().min(min).max(max).default(fallback));

export const replyModes = ['draft', 'automatic', 'disabled'] as const;
export type ReplyMode = (typeof replyModes)[number];

export const envSchema = z
  .object({
    // --- DeoMail -----------------------------------------------------------
    DEOMAIL_API_KEY: z.string().min(1, 'DEOMAIL_API_KEY is required'),
    DEOMAIL_BASE_URL: z.preprocess(emptyToUndef, z.string().url().default('https://api.deomail.com/v1')),
    DEOMAIL_SENDER: z.preprocess(emptyToUndef, z.string().min(3).default('support@omhackz.top')),

    // --- Webhook authentication -------------------------------------------
    WEBHOOK_SECRET: z.string().min(16, 'WEBHOOK_SECRET must be at least 16 characters'),
    WEBHOOK_SECRET_HEADER: z.preprocess(emptyToUndef, z.string().default('X-Webhook-Secret')),
    WEBHOOK_ALLOW_QUERY_SECRET: bool(false),
    WEBHOOK_SECRET_QUERY_PARAM: z.preprocess(emptyToUndef, z.string().default('secret')),
    WEBHOOK_SIGNATURE_ENABLED: bool(false),
    WEBHOOK_SIGNATURE_HEADER: z.preprocess(emptyToUndef, z.string().default('X-Webhook-Signature')),

    // --- Agnes AI ----------------------------------------------------------
    AGNES_API_KEY: z.string().min(1, 'AGNES_API_KEY is required'),
    AGNES_BASE_URL: z.preprocess(emptyToUndef, z.string().url().default('https://apihub.agnes-ai.com/v1')),
    AGNES_MODEL: z.preprocess(emptyToUndef, z.string().min(1).default('agnes-2.5-flash')),
    AGNES_TEMPERATURE: z.preprocess(emptyToUndef, z.coerce.number().min(0).max(2).default(0.5)),
    AGNES_MAX_TOKENS: int(500, 32, 32000),
    AGNES_TIMEOUT_MS: int(25000, 1000, 120000),
    AGNES_MAX_RETRIES: int(2, 0, 5),

    // --- Application -------------------------------------------------------
    AUTO_REPLY_MODE: z.preprocess(emptyToUndef, z.enum(replyModes).default('draft')),
    /** Fire webhook payload profile: "canonical" (default) or "extended". */
    DEOMAIL_WEBHOOK_PROFILE: z.preprocess(emptyToUndef, z.enum(['canonical', 'extended']).default('canonical')),
    APP_NAME: z.preprocess(emptyToUndef, z.string().min(1).default('OmMail AI')),
    APP_URL: z.preprocess(emptyToUndef, z.string().default('https://mailbot.omhackz.top')),
    APP_VERSION: z.preprocess(emptyToUndef, z.string().default('1.0.0')),
    LOG_LEVEL: z.preprocess(emptyToUndef, z.enum(['debug', 'info', 'warn', 'error']).default('info')),
    AI_SYSTEM_PROMPT: z.preprocess(emptyToUndef, z.string().max(20000).optional()),
    REPLY_SIGNATURE: z.preprocess(
      emptyToUndef,
      z.string().max(2000).default('Best regards,\nOmHackz\nsupport@omhackz.top'),
    ),

    // --- Limits ------------------------------------------------------------
    MAX_REPLIES_PER_SENDER_DAY: int(3, 0, 1000),
    MAX_REPLIES_PER_DAY: int(25, 0, 100000),
    MAX_EMAIL_BODY_CHARS: int(12000, 200, 500000),
    MAX_AI_RESPONSE_CHARS: int(4000, 100, 100000),
    MAX_WEBHOOK_BYTES: int(256000, 1024, 5000000),
    MAX_RETRIES: int(3, 0, 10),
    MAX_CONVERSATION_REPLIES: int(1, 1, 50),
    ALLOW_MULTIPLE_REPLIES_PER_CONVERSATION: bool(false),

    // --- Self / escalation -------------------------------------------------
    SELF_DOMAINS: z.preprocess(emptyToUndef, z.string().default('omhackz.top')),
    SELF_ADDRESSES: z.preprocess(emptyToUndef, z.string().default('support@omhackz.top')),
    ESCALATION_RECIPIENTS: z.preprocess(emptyToUndef, z.string().default('')),

    // --- Safety ------------------------------------------------------------
    INJECTION_SENSITIVITY: z.preprocess(emptyToUndef, z.enum(['low', 'medium', 'high']).default('medium')),
    /** Spam score threshold; only applied when the provider sends a score header. */
    SPAM_SCORE_THRESHOLD: int(6, 0, 1000),
    /** Scale used by the provider spam score (0-10 by default). */
    SPAM_SCORE_MAX: int(10, 1, 1000),

    // --- Storage -----------------------------------------------------------
    STORAGE_PROVIDER: z.preprocess(emptyToUndef, z.enum(['redis', 'memory']).default('redis')),
    REDIS_PREFIX: z.preprocess(emptyToUndef, z.string().min(1).default('ommail')),
    UPSTASH_REDIS_REST_URL: z.preprocess(emptyToUndef, z.string().url().optional()),
    UPSTASH_REDIS_REST_TOKEN: z.preprocess(emptyToUndef, z.string().min(1).optional()),

    // --- Admin -------------------------------------------------------------
    ADMIN_SECRET: z.string().min(16, 'ADMIN_SECRET must be at least 16 characters'),
    ADMIN_RATE_LIMIT_PER_MINUTE: int(60, 1, 10000),
  })
  .superRefine((value, ctx) => {
    if (value.STORAGE_PROVIDER === 'redis') {
      if (!value.UPSTASH_REDIS_REST_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['UPSTASH_REDIS_REST_URL'],
          message: 'UPSTASH_REDIS_REST_URL is required when STORAGE_PROVIDER=redis',
        });
      }
      if (!value.UPSTASH_REDIS_REST_TOKEN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['UPSTASH_REDIS_REST_TOKEN'],
          message: 'UPSTASH_REDIS_REST_TOKEN is required when STORAGE_PROVIDER=redis',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Parse and validate an environment. Throws `ConfigError` listing problems. */
export function parseEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
  const missing = issues.filter((i) => /required|at least/i.test(i.message)).map((i) => i.field);

  throw new ConfigError(
    `Invalid environment configuration (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
    { issues, missing },
  );
}

let cached: Env | null = null;

/** Parse `process.env` (cached). */
export function getEnv(): Env {
  if (!cached) cached = parseEnv(process.env as Record<string, unknown>);
  return cached;
}

/** Clear the cached environment (used by tests). */
export function resetEnvCache(): void {
  cached = null;
}

function splitList(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

/** Domains that are considered "ours" (never auto-replied to). */
export function selfDomains(env: Env): string[] {
  return splitList(env.SELF_DOMAINS);
}

/** Full addresses that are considered "ours". */
export function selfAddresses(env: Env): string[] {
  return splitList(env.SELF_ADDRESSES);
}

/** Addresses notified about escalated / risky messages. */
export function escalationRecipients(env: Env): string[] {
  return splitList(env.ESCALATION_RECIPIENTS);
}
