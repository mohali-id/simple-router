/**
 * Endpoint model non-chat (images, audio, embeddings, moderation): passthrough
 * tanpa translasi, dengan fallback. Mendukung body JSON dan multipart/form-data.
 */
import type { Context } from 'hono';
import type { ApiType } from '../config/index.js';
import type { AppEnv, RouterContext } from '../context.js';
import { RouterError } from '../errors.js';
import { pickRequestHeaders, pickResponseHeaders } from '../http.js';
import { callUpstream } from '../providers/client.js';
import { allFailedError, retryOutcome, tryTargets, type AttemptOutcome } from '../router/fallback.js';
import { upstreamPathFor } from '../router/paths.js';
import { resolveModel } from '../router/resolve.js';
import { readJsonBody } from './chat.js';

interface ParsedBody {
  model: string | undefined;
  build: (upstreamModel: string) => NonNullable<RequestInit['body']>;
  multipart: boolean;
}

async function parseBody(c: Context<AppEnv>): Promise<ParsedBody> {
  const contentType = c.req.header('content-type') ?? '';
  if (contentType.includes('multipart/form-data')) {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      throw new RouterError(400, 'body multipart tidak valid');
    }
    const model = form.get('model');
    return {
      model: typeof model === 'string' ? model : undefined,
      multipart: true,
      build: (upstreamModel) => {
        const out = new FormData();
        for (const [key, value] of form.entries()) if (key !== 'model') out.append(key, value);
        out.append('model', upstreamModel);
        return out;
      },
    };
  }
  const body = await readJsonBody(c);
  return {
    model: typeof body.model === 'string' ? body.model : undefined,
    multipart: false,
    build: (upstreamModel) => JSON.stringify({ ...body, model: upstreamModel }),
  };
}

export function createModelPassthroughHandler(rc: RouterContext, apiType: ApiType) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    const parsed = await parseBody(c);

    // Model opsional (mis. moderations): pakai model pertama dengan api-type ini.
    const requested = parsed.model?.trim() || rc.config.models.find((m) => m.apiType === apiType)?.ref;
    if (!requested) throw new RouterError(400, 'field "model" wajib diisi');

    const { routeId, targets } = resolveModel(rc.config, rc.state, requested, {
      provider: c.req.header('x-router-provider'),
    });
    c.set('route', routeId);

    const result = await tryTargets(
      targets,
      { state: rc.state, cooldownMs: rc.config.server.cooldownMs, logger: rc.logger, reqId: c.get('reqId') },
      async (target): Promise<AttemptOutcome> => {
        if (target.model.apiType !== apiType) {
          return { type: 'next', status: 400, message: `model "${target.model.ref}" (${target.model.apiType}) tidak melayani ${apiType}`, cooldown: false };
        }
        const headers = pickRequestHeaders(c.req.raw.headers, ['accept', 'openai-beta', 'idempotency-key']);
        if (!parsed.multipart) headers.set('content-type', 'application/json');

        const res = await callUpstream({
          provider: target.provider,
          apiType,
          path: upstreamPathFor(apiType, c.req.path),
          method: 'POST',
          headers,
          body: parsed.build(target.model.id),
          signal: c.req.raw.signal,
          timeoutMs: rc.config.server.timeoutMs,
          fetch: rc.fetch,
        });

        if (!res.ok) {
          const retry = await retryOutcome(res);
          if (retry) return retry;
        }
        const outHeaders = pickResponseHeaders(res.headers);
        outHeaders.set('x-router-route', routeId);
        outHeaders.set('x-router-target', target.model.ref);
        return { type: 'done', success: res.ok, response: new Response(res.body, { status: res.status, headers: outHeaders }) };
      },
    );

    c.set('fallbacks', result.failures.length);
    if (result.target) c.set('target', result.target.model.ref);
    if (result.response) return result.response;
    throw allFailedError(result.failures);
  };
}
