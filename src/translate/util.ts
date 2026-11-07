import { createHash, randomBytes } from 'node:crypto';
import { isRecord } from '../http.js';

export { isRecord };

export function genId(prefix: string): string {
  return `${prefix}${randomBytes(12).toString('hex')}`;
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Field `user` OpenAI maksimal 64 karakter, sedangkan `metadata.user_id` Anthropic
 * (mis. dari Claude Code) bisa jauh lebih panjang. Id panjang di-hash (sha256 hex =
 * tepat 64 karakter) agar tetap stabil per user tanpa ditolak upstream.
 */
export function toOpenAIUser(user: string | undefined): string | undefined {
  if (!user) return undefined;
  return user.length <= 64 ? user : createHash('sha256').update(user).digest('hex');
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** JSON.parse yang tidak melempar; argumen tool yang rusak menjadi `{}`. */
export function parseJsonObject(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Buang key bernilai undefined (agar body upstream bersih). */
export function compact<T extends Record<string, unknown>>(obj: T): T {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj;
}

/** `data:<mime>;base64,<data>` → { mediaType, data } */
export function parseDataUrl(url: string): { mediaType: string; data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!match?.[1] || match[2] === undefined) return undefined;
  return { mediaType: match[1], data: match[2] };
}

/** Ambil teks dari content string atau array part (`text`, `input_text`, `output_text`). */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  return asArray(content)
    .map((p) => (isRecord(p) && typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('\n');
}

export function toStopArray(stop: unknown): string[] | undefined {
  if (typeof stop === 'string') return [stop];
  if (Array.isArray(stop)) {
    const list = stop.filter((s): s is string => typeof s === 'string');
    return list.length ? list : undefined;
  }
  return undefined;
}
