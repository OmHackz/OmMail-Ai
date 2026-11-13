/** Text utilities: subject normalisation, truncation and light language detection. */

const REPLY_PREFIX_RE = /^\s*(re|fwd|fw|aw|antw|sv|vs|res|odp)\s*(\[\d+\])?\s*[:\-–]\s*/i;

/** Remove any number of leading `Re:` / `Fwd:` prefixes. */
export function stripReplyPrefix(subject: string): string {
  let out = subject.trim();
  let previous = '';
  while (out !== previous) {
    previous = out;
    out = out.replace(REPLY_PREFIX_RE, '');
  }
  return out.trim();
}

/** Build a reply subject: `Re: <normalised original subject>`. */
export function buildReplySubject(originalSubject: string): string {
  const base = stripReplyPrefix(originalSubject ?? '').trim();
  if (!base) return 'Re: your message';
  return `Re: ${base}`.slice(0, 250);
}

/** Normalised conversation key: sender + subject without reply prefixes. */
export function conversationKey(sender: string, subject: string): string {
  return `${sender.toLowerCase()}|${stripReplyPrefix(subject ?? '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
}

export function truncate(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `${input.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function collapseWhitespace(input: string): string {
  return input.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export function normalizeHeaderValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string').join(' ');
  return String(value);
}

const STOPWORDS: Record<string, string[]> = {
  es: ['el', 'la', 'los', 'las', 'de', 'que', 'y', 'por', 'para', 'con', 'una', 'por favor', 'hola', 'gracias'],
  fr: ['le', 'la', 'les', 'des', 'que', 'et', 'pour', 'avec', 'bonjour', 'merci', 'salut', 'je'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'für', 'mit', 'hallo', 'danke', 'bitte', 'ich'],
  pt: ['o', 'a', 'os', 'as', 'de', 'que', 'e', 'para', 'com', 'olá', 'obrigado', 'por favor'],
  it: ['il', 'la', 'di', 'che', 'e', 'per', 'con', 'ciao', 'grazie', 'per favore'],
  nl: ['de', 'het', 'een', 'en', 'van', 'voor', 'met', 'hallo', 'bedankt', 'graag'],
};

/** Words that strongly identify a language on their own. */
const DISTINCTIVE: Record<string, string[]> = {
  es: ['gracias', 'qué tal', 'cómo estás', 'quisiera', 'favor'],
  fr: ['bonjour', 'salut', 'merci', 'bonsoir', 'cordialement'],
  de: ['danke', 'bitte', 'grüßen', 'möchte', 'hallo'],
  pt: ['obrigado', 'olá', 'saudações', 'favor'],
  it: ['ciao', 'grazie', 'prego', 'salve'],
  nl: ['bedankt', 'graag', 'goedendag'],
};

/**
 * Very small heuristic language detector.
 * It only decides whether to hint a language to the model — the model is
 * instructed to answer in the sender's language anyway.
 */
export function detectLanguage(text: string): string {
  const sample = (text ?? '').slice(0, 4000);
  if (!sample.trim()) return 'en';

  if (/[\u4e00-\u9fff]/.test(sample)) return 'zh';
  if (/[\u3040-\u30ff]/.test(sample)) return 'ja';
  if (/[\uac00-\ud7af]/.test(sample)) return 'ko';
  if (/[\u0400-\u04ff]/.test(sample)) return 'ru';
  if (/[\u0600-\u06ff]/.test(sample)) return 'ar';
  if (/[\u0590-\u05ff]/.test(sample)) return 'he';
  if (/[\u0900-\u097f]/.test(sample)) return 'hi';
  if (/[\u0e00-\u0e7f]/.test(sample)) return 'th';

  const words = sample.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  if (words.length < 2) return 'en';

  const normalized = sample.toLowerCase();

  for (const [lang, markers] of Object.entries(DISTINCTIVE)) {
    if (markers.some((marker) => normalized.includes(marker))) return lang;
  }

  let best = 'en';
  let bestScore = 0;
  for (const [lang, stops] of Object.entries(STOPWORDS)) {
    const score = words.filter((w) => stops.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      best = lang;
    }
  }
  return bestScore >= 2 ? best : 'en';
}

/** True when the text contains a URL. */
export function containsUrl(text: string): boolean {
  return /\bhttps?:\/\/[^\s<>"']+/i.test(text);
}

/** Extract the first URL found in the text (if any). */
export function extractFirstUrl(text: string): string | null {
  const match = text.match(/\bhttps?:\/\/[^\s<>"')]+/i);
  return match ? match[0] : null;
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
