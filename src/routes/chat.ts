/**
 * Endpoint chat: /v1/chat/completions, /v1/responses, /v1/messages.
 * Resolve route → coba target berurutan → translasi format bila perlu.
 */
import type { Context } from 'hono';
import type { AppEnv, RouterContext } from '../context.js';
import { errorResponse, extractErrorMessage, RouterError } from '../errors.js';
import { isRecord, pickRequestHeaders, pickResponseHeaders, readJsonSafe, SSE_HEADERS } from '../http.js';
import { callUpstream } from '../providers/client.js';
import { allFailedError, retryOutcome, tryTargets, type AttemptOutcome } from '../router/fallback.js';
import { defaultUpstreamPath } from '../router/paths.js';
import { resolveModel } from '../router/resolve.js';
import { isChatFormat, translateRequest, translateResponse, translateStream, TranslationError, type ChatFormat } from '../translate/index.js';

const FORWARD = ['openai-beta', 'anthropic-beta', 'anthropic-version', 'idempotency-key'];

export async function readJsonBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new RouterError(400, 'body harus JSON yang valid');
  }
  if (!isRecord(body)) throw new RouterError(400, 'body harus berupa object JSON');
  return body;
}

export function createChatHandler(rc: RouterContext, inbound: ChatFormat) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    const format = c.get('errorFormat');
    const body = await readJsonBody(c);
    if (typeof body.model !== 'string' || !body.model.trim()) {
      throw new RouterError(400, 'field "model" wajib diisi');
    }
    const stream = body.stream === true;
    const includeUsage = isRecord(body.stream_options) && body.stream_options.include_usage === true;

    const { routeId, targets } = resolveModel(rc.config, rc.state, body.model, {
      provider: c.req.header('x-router-provider'),
    });
    c.set('route', routeId);

    const result = await tryTargets(
      targets,
      { state: rc.state, cooldownMs: rc.config.server.cooldownMs, logger: rc.logger, reqId: c.get('reqId') },
      async (target): Promise<AttemptOutcome> => {
        const upstream = target.model.apiType;
        if (!isChatFormat(upstream)) {
          return { type: 'next', status: 400, message: `model "${target.model.ref}" (${upstream}) tidak melayani ${inbound}`, cooldown: false };
        }

        let upstreamBody: Record<string, unknown>;
        try {
          upstreamBody = translateRequest(inbound, upstream, body, target.model.id);
        } catch (err) {
          if (err instanceof TranslationError) return { type: 'next', status: 400, message: err.message, cooldown: false };
          throw err;
        }

        const headers = pickRequestHeaders(c.req.raw.headers, FORWARD);
        headers.set('content-type', 'application/json');
        headers.set('accept', stream ? 'text/event-stream' : 'application/json');

        const res = await callUpstream({
          provider: target.provider,
          apiType: upstream,
          path: defaultUpstreamPath(upstream),
          method: 'POST',
          headers,
          body: JSON.stringify(upstreamBody),
          signal: c.req.raw.signal,
          timeoutMs: rc.config.server.timeoutMs,
          fetch: rc.fetch,
        });

        const outHeaders = pickResponseHeaders(res.headers);
        outHeaders.set('x-router-route', routeId);
        outHeaders.set('x-router-target', target.model.ref);

        if (!res.ok) {
          const retry = await retryOutcome(res);
          if (retry) return retry;
          // Error 4xx lain: kembalikan ke client tanpa fallback.
          if (upstream === inbound) {
            return { type: 'done', success: false, response: new Response(res.body, { status: res.status, headers: outHeaders }) };
          }
          const errBody = await readJsonSafe(res);
          const message = extractErrorMessage(errBody, `upstream HTTP ${res.status}`);
          return {
            type: 'done',
            success: false,
            response: errorResponse(format, res.status, message, undefined, Object.fromEntries(outHeaders)),
          };
        }

        if (stream) {
          if (!res.body) return { type: 'next', status: 502, message: 'upstream tidak mengirim body stream', cooldown: true };
          const translated = translateStream(upstream, inbound, res.body, {
            includeUsage,
            onError: (err) =>
              rc.logger.warn('stream upstream error', {
                req: c.get('reqId'),
                target: target.model.ref,
                reason: err instanceof Error ? err.message : String(err),
              }),
          });
          if (upstream !== inbound) {
            outHeaders.delete('content-type');
            for (const [k, v] of Object.entries(SSE_HEADERS)) outHeaders.set(k, v);
          }
          return { type: 'done', success: true, response: new Response(translated, { status: 200, headers: outHeaders }) };
        }

        const json = await readJsonSafe(res);
        if (!isRecord(json)) return { type: 'next', status: 502, message: 'respons upstream bukan JSON', cooldown: true };
        outHeaders.set('content-type', 'application/json');
        return {
          type: 'done',
          success: true,
          response: new Response(JSON.stringify(translateResponse(upstream, inbound, json)), { status: 200, headers: outHeaders }),
        };
      },
    );

    c.set('fallbacks', result.failures.length);
    if (result.target) c.set('target', result.target.model.ref);
    if (result.response) return result.response;
    throw allFailedError(result.failures);
  };
}
