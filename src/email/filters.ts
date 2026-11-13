import { emailDomain, isSameOrSubdomain } from '../lib/security';
import { containsUrl, extractFirstUrl, hostOf } from '../lib/text';
import type { IncomingEmail } from '../types';

/**
 * Eligibility and safety rules for inbound email.
 *
 * `eligible` means "worth answering at all".
 * `escalate` means "do not send automatically — a human must look at it".
 */

export type FilterReason =
  | 'eligible'
  | 'self_email'
  | 'invalid_sender'
  | 'empty_body'
  | 'auto_submitted'
  | 'auto_response_suppressed'
  | 'precedence_bulk'
  | 'list_unsubscribe'
  | 'list_id'
  | 'mailing_list'
  | 'auto_responder_sender'
  | 'auto_responder_subject'
  | 'delivery_status'
  | 'spam_flagged'
  | 'spam_score'
  | 'phishing_suspected'
  | 'prompt_injection'
  | 'sensitive_content';

export interface FilterInput {
  email: IncomingEmail;
  selfDomains: string[];
  selfAddresses: string[];
  /** Spam score threshold (only applied when the provider supplies a score). */
  spamScoreThreshold?: number;
  /** Maximum value of the provider spam score scale. */
  spamScoreMax?: number;
  /** Injection detection result for the message body. */
  injectionDetected?: boolean;
  injectionFindings?: string[];
  /** Extra subjects to test (for example the subject from the webhook event). */
  additionalSubjects?: string[];
}

export interface FilterOutcome {
  eligible: boolean;
  escalate: boolean;
  reason: FilterReason;
  detail?: string;
  severity: 'info' | 'warn' | 'danger';
}

const AUTO_SENDER_PREFIXES = [
  'noreply',
  'no-reply',
  'no_reply',
  'donotreply',
  'do-not-reply',
  'do_not_reply',
  'autoreply',
  'auto-reply',
  'auto_reply',
  'automated',
  'bounce',
  'bounce-',
  'mailer-daemon',
  'postmaster',
  'abuse',
  'notification',
  'notifications',
  'alerts',
  'alerts-',
  'newsletter',
  'news',
  'marketing',
  'unsubscribe',
  'list',
  'mailer',
  'reply-',
  'automated-',
];

const AUTO_SUBJECT_PATTERNS: Array<{ re: RegExp; reason: FilterReason }> = [
  { re: /\bauto(?:matically)?[- ]?(?:responded?|reply|generated)\b/i, reason: 'auto_responder_subject' },
  { re: /\bout of (?:the )?office\b/i, reason: 'auto_responder_subject' },
  { re: /\baway from (?:my |the )?(?:mail|inbox|desk)\b/i, reason: 'auto_responder_subject' },
  { re: /\bautomatic (?:reply|response|answer)\b/i, reason: 'auto_responder_subject' },
  { re: /\bread receipt\b/i, reason: 'auto_responder_subject' },
  { re: /\b(?:undeliverable|delivery status notification|delivery failure|delivery report|failed delivery|mail delivery failed|mailer delivery|returning message|returned mail|mail loop detected)\b/i, reason: 'delivery_status' },
  { re: /\b(?:no[- ]reply|cannot be delivered|message not delivered|delivery incomplete|smtp error)\b/i, reason: 'delivery_status' },
  { re: /\b(?:unsubscribe|manage your (?:email )?preferences|newsletter|weekly digest|marketing (?:email|update)|product (?:updates|announcement))\b/i, reason: 'mailing_list' },
];

const CREDENTIAL_PATTERNS: RegExp[] = [
  /\bpassword\b/i,
  /\bapi[_ -]?key\b/i,
  /\bsecret[_ -]?key\b/i,
  /\bprivate key\b/i,
  /\bseed phrase\b/i,
  /\b2fa code\b/i,
  /\bone[- ]time (?:code|password|otp)\b/i,
  /\bcredit card\b/i,
  /\bcard number\b/i,
  /\bbank account\b/i,
  /\bssn\b/i,
];

const SENSITIVE_PATTERNS: RegExp[] = [
  /\b(?:nda|non[- ]disclosure agreement|contract|agreement|terms of service|invoice|payment|refund|billing|lawsuit|attorney|legal (?:advice|notice|action))\b/i,
  /\b(?:threaten(?:ing)?|harass(?:ment|ing)?|abuse(?:r|ive)?|fraud(?:ulent)?|scam|money launder)\b/i,
];

const URGENCY_PATTERNS: RegExp[] = [
  /\bact now\b/i,
  /\bverify your account\b/i,
  /\bconfirm your identity\b/i,
  /\baccount (?:has been )?suspended\b/i,
  /\bwithin 24 hours\b/i,
  /\bimmediate action required\b/i,
  /\bfailure to comply\b/i,
];

const SHORTENER_HOSTS = new Set([
  'bit.ly',
  'tinyurl.com',
  't.co',
  'is.gd',
  'cutt.ly',
  'rebrand.ly',
  'shorturl.at',
  'ow.ly',
]);

const SUSPICIOUS_TLDS = ['.zip', '.mov', '.top', '.xyz', '.click', '.link', '.gq', '.tk', '.ml'];

export function evaluateEmail(input: FilterInput): FilterOutcome {
  const { email } = input;
  const headers = email.headers ?? {};
  const header = (name: string): string => (headers[name] ?? '').trim();

  // 1. Never answer our own mail (prevents auto-reply loops).
  if (input.selfAddresses.includes(email.fromEmail.toLowerCase())) {
    return { eligible: false, escalate: false, reason: 'self_email', severity: 'info' };
  }
  const domain = emailDomain(email.fromEmail);
  if (domain && input.selfDomains.some((root) => isSameOrSubdomain(domain, root))) {
    return { eligible: false, escalate: false, reason: 'self_email', severity: 'info' };
  }

  // 2. A reply needs a usable sender address.
  if (!email.fromEmail || !email.fromEmail.includes('@')) {
    return { eligible: false, escalate: false, reason: 'invalid_sender', severity: 'warn' };
  }

  // 3. Empty content cannot be answered.
  const bodyText = (email.bodyText ?? '').trim();
  const bodyHtml = (email.bodyHtml ?? '').trim();
  if (!bodyText && !bodyHtml) {
    return { eligible: false, escalate: false, reason: 'empty_body', severity: 'info' };
  }

  // 4. RFC 3834 auto-generated mail.
  const autoSubmitted = header('auto-submitted');
  if (autoSubmitted && autoSubmitted.toLowerCase() !== 'no') {
    return { eligible: false, escalate: false, reason: 'auto_submitted', severity: 'info' };
  }

  // 5. Explicit auto-response suppression.
  if (
    header('x-auto-response-suppress').toLowerCase() === 'all' ||
    header('x-autoreply').length > 0 ||
    header('x-autorespond').length > 0
  ) {
    return { eligible: false, escalate: false, reason: 'auto_response_suppressed', severity: 'info' };
  }

  // 6. Bulk / list precedence.
  const precedence = header('precedence').toLowerCase();
  if (['bulk', 'junk', 'list', 'auto_reply'].includes(precedence)) {
    return { eligible: false, escalate: false, reason: 'precedence_bulk', severity: 'info' };
  }

  // 7. Mailing lists and newsletters.
  if (header('list-unsubscribe') || header('list-unsubscribe-post')) {
    return { eligible: false, escalate: false, reason: 'list_unsubscribe', severity: 'info' };
  }
  if (header('list-id')) {
    return { eligible: false, escalate: false, reason: 'list_id', severity: 'info' };
  }

  // 8. Well known automated sender local parts.
  const localPart = email.fromEmail.split('@')[0] ?? '';
  if (AUTO_SENDER_PREFIXES.some((prefix) => localPart.startsWith(prefix))) {
    return { eligible: false, escalate: false, reason: 'auto_responder_sender', severity: 'info' };
  }

  // 9. Subject based detection (auto replies, DSNs, newsletters).
  const subjects = [email.subject ?? '', ...(input.additionalSubjects ?? [])].filter(Boolean);
  for (const pattern of AUTO_SUBJECT_PATTERNS) {
    if (subjects.some((subject) => pattern.re.test(subject))) {
      return { eligible: false, escalate: false, reason: pattern.reason, severity: 'info' };
    }
  }

  // 10. Spam markers supplied by the provider.
  const spamFlag = (header('x-spam-flag') || header('x-spam-status')).toLowerCase();
  if (spamFlag === 'yes' || spamFlag === 'true') {
    return { eligible: false, escalate: false, reason: 'spam_flagged', severity: 'warn' };
  }
  const spamScore = readSpamScore(email);
  if (
    spamScore !== null &&
    typeof input.spamScoreThreshold === 'number' &&
    typeof input.spamScoreMax === 'number' &&
    input.spamScoreMax > 0 &&
    spamScore >= input.spamScoreThreshold
  ) {
    return {
      eligible: false,
      escalate: false,
      reason: 'spam_score',
      severity: 'warn',
      detail: `spam score ${spamScore}/${input.spamScoreMax}`,
    };
  }

  // 11. Prompt injection — never let untrusted content drive the assistant.
  if (input.injectionDetected) {
    return {
      eligible: true,
      escalate: true,
      reason: 'prompt_injection',
      severity: 'danger',
      detail: input.injectionFindings?.join(', '),
    };
  }

  // 12. Phishing heuristics.
  const phishing = assessPhishing(email, domain);
  if (phishing.score >= 3) {
    return {
      eligible: true,
      escalate: true,
      reason: 'phishing_suspected',
      severity: 'danger',
      detail: phishing.reasons.join(', '),
    };
  }

  // 13. Sensitive topics always require a human.
  const content = `${email.subject ?? ''}\n${bodyText}`;
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(content))) {
    return { eligible: true, escalate: true, reason: 'sensitive_content', severity: 'danger', detail: 'credentials' };
  }
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(content))) {
    return { eligible: true, escalate: true, reason: 'sensitive_content', severity: 'warn', detail: 'sensitive topic' };
  }

  return { eligible: true, escalate: false, reason: 'eligible', severity: 'info' };
}

function readSpamScore(email: IncomingEmail): number | null {
  const headers = email.headers ?? {};
  const candidates = ['x-spam-score', 'x-deomail-spam-score', 'x-spamrating', 'x-spam-rating'];
  for (const name of candidates) {
    const value = headers[name];
    if (value === undefined) continue;
    const parsed = Number(String(value).trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

interface PhishingAssessment {
  score: number;
  reasons: string[];
}

export function assessPhishing(email: IncomingEmail, senderDomain: string): PhishingAssessment {
  const reasons: string[] = [];
  let score = 0;

  const headers = email.headers ?? {};
  const replyTo = headers['reply-to'] ?? '';
  const replyToDomain = replyTo.includes('@') ? emailDomain(replyTo.split('<').pop() ?? replyTo) : '';
  if (replyToDomain && senderDomain && replyToDomain !== senderDomain) {
    score += 2;
    reasons.push('reply_to_domain_mismatch');
  }

  const body = `${email.subject ?? ''}\n${email.bodyText ?? ''}`;
  if (containsUrl(body)) {
    const url = extractFirstUrl(body);
    const host = url ? hostOf(url) : null;
    if (host && SHORTENER_HOSTS.has(host)) {
      score += 2;
      reasons.push('shortened_url');
    } else if (host && senderDomain && !isSameOrSubdomain(host, senderDomain)) {
      score += 1;
      reasons.push('external_link');
    }
    if (host && SUSPICIOUS_TLDS.some((tld) => host.endsWith(tld))) {
      score += 1;
      reasons.push('suspicious_tld');
    }
  }

  if (URGENCY_PATTERNS.some((pattern) => pattern.test(body))) {
    score += 1;
    reasons.push('urgency_language');
  }
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(body))) {
    score += 1;
    reasons.push('credential_request');
  }

  return { score, reasons };
}
