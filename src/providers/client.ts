import type { ApiType, Provider } from '../config/index.js';

export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_FILES_BETA = 'files-api-2025-04-14';

export class UpstreamTimeoutError extends Error {
  constructor(ms: number) {
    super(`upstream tidak merespons dalam ${ms} ms`);
    this.name = 'UpstreamTimeoutError';
  }
}

export class UpstreamNetworkError extends Error {
  constructor(cause: unknown) {
    super(`gagal menghubungi upstream: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'UpstreamNetworkError';
  }
}

export interface UpstreamCall {
  provider: Provider;
  apiType: ApiType;
  /** Path relatif base-url, mis. `/chat/completions`. */
  path: string;
  /** Query string termasuk `?`, atau kosong. */
  search?: string;
  method: string;
  /** Header tambahan (sudah difilter); auth upstream ditambahkan di sini. */
  headers?: Headers;
  body?: RequestInit['body'];
  /** Signal dari client (abort saat client putus). */
  signal?: AbortSignal;
  /** Batas waktu sampai header respons diterima. */
  timeoutMs: number;
  fetch: typeof fetch;
}

/** Tambahkan header auth & versi sesuai gaya provider. */
export function buildUpstreamHeaders(provider: Provider, apiType: ApiType, base?: Headers): Headers {
  const headers = new Headers(base);
  headers.delete('authorization');
  headers.delete('x-api-key');
  if (provider.type === 'anthropic') {
    headers.set('x-api-key', provider.apiKey);
    if (!headers.has('anthropic-version')) headers.set('anthropic-version', ANTHROPIC_VERSION);
    if (apiType === 'anthropic-files') {
      const betas = new Set(
        (headers.get('anthropic-beta') ?? '')
          .split(',')
          .map((b) => b.trim())
          .filter(Boolean),
      );
      betas.add(ANTHROPIC_FILES_BETA);
      headers.set('anthropic-beta', [...betas].join(','));
    }
  } else {
    headers.set('authorization', `Bearer ${provider.apiKey}`);
    headers.delete('anthropic-version');
    headers.delete('anthropic-beta');
  }
  return headers;
}

/**
 * Panggil upstream. Timeout hanya berlaku sampai header respons diterima,
 * sehingga stream panjang tidak terpotong; abort dari client tetap diteruskan.
 */
export async function callUpstream(call: UpstreamCall): Promise<Response> {
  const url = `${call.provider.baseUrl}${call.path}${call.search ?? ''}`;
  const controller = new AbortController();
  const onClientAbort = () => controller.abort(call.signal?.reason);
  if (call.signal?.aborted) controller.abort(call.signal.reason);
  call.signal?.addEventListener('abort', onClientAbort, { once: true });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new UpstreamTimeoutError(call.timeoutMs));
  }, call.timeoutMs);

  const isStreamBody = call.body instanceof ReadableStream;
  const init: RequestInit & { duplex?: 'half' } = {
    method: call.method,
    headers: buildUpstreamHeaders(call.provider, call.apiType, call.headers),
    body: call.method === 'GET' || call.method === 'HEAD' ? undefined : (call.body ?? undefined),
    signal: controller.signal,
    ...(isStreamBody ? { duplex: 'half' as const } : {}),
  };

  try {
    return await call.fetch(url, init);
  } catch (err) {
    if (timedOut) throw new UpstreamTimeoutError(call.timeoutMs);
    if (call.signal?.aborted) throw err;
    throw new UpstreamNetworkError(err);
  } finally {
    clearTimeout(timer);
    // Listener tetap terpasang saat body masih di-stream; dilepas saat request client selesai.
  }
}
