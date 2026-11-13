import { escapeHtml } from '../lib/security';
import { buildReplySubject } from '../lib/text';

/** Compose the outgoing plain-text body (reply text + official signature). */
export function composeReplyBody(replyText: string, signature?: string): string {
  const body = (replyText ?? '').trim();
  if (!signature || !signature.trim()) return body;
  const sign = signature.trim();
  if (body.toLowerCase().includes(sign.toLowerCase())) return body;
  return `${body}\n\n${sign}`;
}

/** Build a simple, safe HTML version of the reply. */
export function composeReplyHtml(replyText: string, signature?: string): string {
  const paragraphs = (replyText ?? '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => {
      const lines = block.split('\n').map((line) => escapeHtml(line.trim()));
      if (lines.length === 1) return `<p>${lines[0]}</p>`;
      return `<p>${lines.join('<br />')}</p>`;
    });

  const sign = signature?.trim();
  const signatureHtml = sign
    ? `<p style="margin-top:24px">${sign.split('\n').map((line) => escapeHtml(line.trim())).join('<br />')}</p>`
    : '';

  return [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#111827">',
    ...paragraphs,
    signatureHtml,
    '</div>',
  ].join('');
}

/** Subject line used for the reply. */
export function replySubject(originalSubject: string): string {
  return buildReplySubject(originalSubject);
}
