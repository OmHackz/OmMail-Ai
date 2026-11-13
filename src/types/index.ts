/** Shared domain types for OmMail AI. */

export type ReplyMode = 'draft' | 'automatic' | 'disabled';

export type ProcessingState =
  | 'received'
  | 'fetched'
  | 'filtered'
  | 'draft_created'
  | 'sent'
  | 'skipped'
  | 'escalated'
  | 'failed'
  | 'send_uncertain'
  | 'duplicate';

export type ErrorCategory =
  | 'config'
  | 'auth'
  | 'validation'
  | 'blocked'
  | 'duplicate'
  | 'rate_limit'
  | 'timeout'
  | 'upstream'
  | 'storage'
  | 'internal';

/** A normalised inbound email, independent of the webhook transport shape. */
export interface IncomingEmail {
  /** DeoMail email id (the `{{email_id}}` Fire variable). */
  providerId: string;
  /** Raw `From` header value. */
  from: string;
  /** Normalised sender address. */
  fromEmail: string;
  /** Display name when present. */
  fromName?: string;
  /** Recipients the message was addressed to. */
  to: string[];
  subject: string;
  /** Plain-text body (may be a preview when Fire truncates it). */
  bodyText: string;
  /** HTML body when available. */
  bodyHtml?: string;
  /** Raw headers when available. */
  headers: Record<string, string>;
  receivedAt?: string;
  attachmentCount: number;
  /** True when the provider reports attachments on the message. */
  hasAttachments?: boolean;
  /** True when the body was fetched from the DeoMail API rather than the webhook. */
  bodyFromApi: boolean;
  /** True when Fire only delivered a truncated preview. */
  bodyIsPreview: boolean;
  /** The untouched webhook payload (kept for troubleshooting, never logged). */
  rawPayload: unknown;
}

export interface Draft {
  id: string;
  emailId: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  status: 'pending' | 'escalated' | 'approved' | 'sent' | 'rejected' | 'failed';
  reason?: string;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
  error?: string;
  deomailMessageId?: string;
  source: 'webhook' | 'manual';
  language?: string;
}

export interface ActivityEntry {
  id: string;
  ts: string;
  event: string;
  state?: ProcessingState;
  emailId?: string;
  sender?: string;
  subject?: string;
  errorCategory?: ErrorCategory;
  errorCode?: string;
  durationMs?: number;
  detail?: string;
  requestId?: string;
}

export interface AppSettings {
  mode: ReplyMode;
  /** Master switch: when false nothing is ever sent. */
  enabled: boolean;
  systemPrompt?: string;
  signature?: string;
  updatedAt: string;
  updatedBy?: string;
}

export interface UsageStats {
  processed: number;
  repliesGenerated: number;
  repliesSent: number;
  draftsPending: number;
  failed: number;
  skipped: number;
  duplicates: number;
  escalations: number;
}

export interface DailyStats extends UsageStats {
  date: string;
}

export interface RateLimitDecision {
  allowed: boolean;
  reason?: 'daily_limit' | 'sender_limit' | 'conversation_limit';
  globalCount?: number;
  senderCount?: number;
  conversationCount?: number;
}

export interface SendEmailInput {
  from: string;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
  cc?: string[];
  bcc?: string[];
  fingerprint?: boolean;
}

export interface SendEmailResult {
  success: boolean;
  emailId?: string;
  messageId?: string;
  fingerprintId?: string;
  /** Raw response for troubleshooting. */
  raw: unknown;
}

export interface DeoMailAttachment {
  id?: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface DeoMailEmail {
  id: string;
  from: string;
  to: string[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  headers: Record<string, string>;
  receivedAt?: string;
  hasAttachments: boolean;
  attachments: DeoMailAttachment[];
  raw: unknown;
}
