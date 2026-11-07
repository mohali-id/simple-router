/**
 * Error yang dikirim ke client, selalu dalam format endpoint inbound.
 */
export type ErrorFormat = 'openai' | 'anthropic';

export class RouterError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string = defaultCode(status),
  ) {
    super(message);
    this.name = 'RouterError';
  }
}

function defaultCode(status: number): string {
  if (status === 400) return 'invalid_request';
  if (status === 401) return 'invalid_api_key';
  if (status === 403) return 'permission_denied';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit_exceeded';
  if (status === 504) return 'upstream_timeout';
  return 'upstream_error';
}

function openaiType(status: number): string {
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'server_error';
  return 'invalid_request_error';
}

function anthropicType(status: number): string {
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 413) return 'request_too_large';
  if (status === 429) return 'rate_limit_error';
  if (status === 529) return 'overloaded_error';
  if (status >= 500) return 'api_error';
  return 'invalid_request_error';
}

export function errorBody(format: ErrorFormat, status: number, message: string, code = defaultCode(status)): unknown {
  if (format === 'anthropic') {
    return { type: 'error', error: { type: anthropicType(status), message } };
  }
  return { error: { message, type: openaiType(status), param: null, code } };
}

export function errorResponse(
  format: ErrorFormat,
  status: number,
  message: string,
  code?: string,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(errorBody(format, status, message, code)), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Ambil pesan error dari body upstream (format OpenAI atau Anthropic). */
export function extractErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const err = (body as { error?: unknown }).error;
    if (err && typeof err === 'object') {
      const msg = (err as { message?: unknown }).message;
      if (typeof msg === 'string' && msg) return msg;
    }
    if (typeof err === 'string' && err) return err;
    const msg = (body as { message?: unknown }).message;
    if (typeof msg === 'string' && msg) return msg;
  }
  return fallback;
}
