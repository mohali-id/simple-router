/**
 * Helper header untuk request/response upstream.
 */

/** Header client yang aman diteruskan ke upstream (auth client TIDAK termasuk). */
const FORWARD_REQUEST_HEADERS = [
  'accept',
  'content-type',
  'openai-beta',
  'anthropic-beta',
  'anthropic-version',
  'idempotency-key',
];

/** Header upstream yang diteruskan ke client. content-length/encoding sengaja dibuang
 *  karena fetch sudah men-decompress body. */
const FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'content-disposition',
  'cache-control',
  'x-request-id',
  'request-id',
  'openai-processing-ms',
  'retry-after',
];
const FORWARD_RESPONSE_PREFIXES = ['x-ratelimit-', 'anthropic-ratelimit-'];

export function pickRequestHeaders(source: Headers, names: readonly string[] = FORWARD_REQUEST_HEADERS): Headers {
  const out = new Headers();
  for (const name of names) {
    const value = source.get(name);
    if (value) out.set(name, value);
  }
  return out;
}

export function pickResponseHeaders(source: Headers): Headers {
  const out = new Headers();
  source.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (FORWARD_RESPONSE_HEADERS.includes(lower) || FORWARD_RESPONSE_PREFIXES.some((p) => lower.startsWith(p))) {
      out.set(lower, value);
    }
  });
  return out;
}

export const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

export async function readJsonSafe(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: { message: text.slice(0, 500) } };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
