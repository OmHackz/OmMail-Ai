import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

/** Length-safe, constant-time string comparison. */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = createHash('sha256').update(a, 'utf8').digest();
  const bufB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(bufA, bufB);
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function randomRequestId(): string {
  return randomUUID();
}

/**
 * Extract and normalise an email address from a `From`-style header.
 * Handles `Name <user@example.com>`, `<user@example.com>` and bare addresses.
 */
export function extractEmailAddress(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;

  const angle = value.match(/<([^<>]+)>/);
  const candidate = (angle?.[1] ?? value).trim();

  // Strip a trailing semicolon/comment and any display-name prefix.
  const cleaned = candidate.replace(/^["']|["']$/g, '').trim();
  if (!cleaned.includes('@')) return null;

  const atIndex = cleaned.lastIndexOf('@');
  const local = cleaned.slice(0, atIndex);
  const domain = cleaned.slice(atIndex + 1);
  if (!local || !domain) return null;
  if (/\s/.test(local) || /\s/.test(domain)) return null;

  const normalized = `${local.toLowerCase()}@${domain.toLowerCase()}`;
  return isLikelyEmail(normalized) ? normalized : null;
}

/** Extract the display name from a `From`-style header. */
export function extractDisplayName(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const match = raw.match(/^\s*"?([^"<]*?)"?\s*</);
  const name = match?.[1]?.trim();
  return name && name.length > 0 ? name : undefined;
}

const EMAIL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function isLikelyEmail(value: string): boolean {
  if (value.length > 254) return false;
  return EMAIL_RE.test(value);
}

export function emailDomain(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1).toLowerCase();
}

export function isSameOrSubdomain(domain: string, root: string): boolean {
  const d = domain.toLowerCase();
  const r = root.toLowerCase();
  return d === r || d.endsWith(`.${r}`);
}

/** Escape text for safe inclusion in an HTML email body. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Remove active content from HTML that may originate from an AI model or a
 * third party. Used before any HTML body is sent out.
 */
export function sanitizeHtml(html: string): string {
  let out = html;
  out = out.replace(/<\s*(script|style|iframe|object|embed|form|link|meta)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  out = out.replace(/<\s*(script|style|iframe|object|embed|form|link|meta)\b[^>]*>/gi, '');
  out = out.replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(/(href|src)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]*)/gi, '$1="#"');
  out = out.replace(/<\s*\/?\s*(script|style)[^>]*>/gi, '');
  return out;
}

/** Very small HTML -> text converter used to feed HTML mail to the model. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|h[1-6]|li|blockquote|tr)\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/[ ]*\n[ ]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
