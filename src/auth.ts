import { createHash, timingSafeEqual } from 'node:crypto';
import type { ClientKey } from './config/index.js';

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Ambil key dari `Authorization: Bearer <key>` atau `x-api-key`. */
export function extractClientKey(headers: Headers): string | undefined {
  const auth = headers.get('authorization');
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1]) return match[1].trim();
  }
  const apiKey = headers.get('x-api-key')?.trim();
  return apiKey || undefined;
}

/** Cocokkan key secara constant-time. Mengembalikan entri auth (tanpa membocorkan key) atau undefined. */
export function matchClientKey(keys: readonly ClientKey[], candidate: string | undefined): ClientKey | undefined {
  if (!candidate) return undefined;
  const cand = digest(candidate);
  let found: ClientKey | undefined;
  for (const k of keys) {
    // Tetap bandingkan semua key agar waktu tidak bergantung pada posisi.
    if (timingSafeEqual(cand, digest(k.key)) && !found) found = k;
  }
  return found;
}
