import type { HubChunk } from '../types.js';

/** Mengubah chunk hub menjadi teks SSE dalam format inbound. */
export interface StreamEmitter {
  push(chunk: HubChunk): string[];
  /** Akhir stream normal. */
  end(): string[];
  /** Error di tengah stream (setelah respons 200 terkirim). */
  error(message: string): string[];
}

/** Event error dari upstream di tengah stream. */
export class UpstreamStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamStreamError';
  }
}
