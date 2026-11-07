/**
 * Resource stateful: Files & Vector Stores. Passthrough murni ke SATU provider,
 * tanpa translasi dan tanpa fallback (resource hanya ada di provider pembuatnya).
 */
import type { Context } from 'hono';
import type { ApiType } from '../config/index.js';
import type { AppEnv, RouterContext } from '../context.js';
import { RouterError } from '../errors.js';
import { pickRequestHeaders, pickResponseHeaders } from '../http.js';
import { callUpstream, UpstreamNetworkError, UpstreamTimeoutError } from '../providers/client.js';
import { defaultUpstreamPath } from '../router/paths.js';

export type ResourceKind = 'files' | 'vector-stores';

export function selectResourceProvider(rc: RouterContext, kind: ResourceKind, header: string | undefined) {
  const configured = kind === 'files' ? rc.config.application.resources.files : rc.config.application.resources.vectorStores;
  const providerId = header?.trim() || configured?.provider;
  if (!providerId) {
    throw new RouterError(
      400,
      `provider untuk ${kind} belum ditentukan: kirim header x-router-provider atau isi application.resources`,
      'provider_required',
    );
  }
  const provider = rc.config.providers.find((p) => p.id === providerId);
  if (!provider) throw new RouterError(400, `provider "${providerId}" tidak dikenal`, 'provider_not_found');

  let apiType: ApiType;
  if (kind === 'files') apiType = provider.type === 'anthropic' ? 'anthropic-files' : 'openai-files';
  else {
    if (provider.type === 'anthropic') {
      throw new RouterError(400, `provider "${provider.id}" (anthropic) tidak mendukung vector stores`, 'unsupported');
    }
    apiType = 'openai-vector-stores';
  }
  return { provider, apiType };
}

/** `mountPath` = url endpoint di config, mis. `/v1/files`. */
export function createResourceHandler(rc: RouterContext, kind: ResourceKind, mountPath: string) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    const { provider, apiType } = selectResourceProvider(rc, kind, c.req.header('x-router-provider'));
    c.set('target', provider.id);

    const suffix = c.req.path.slice(mountPath.length);
    const method = c.req.method.toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD';

    let res: Response;
    try {
      res = await callUpstream({
        provider,
        apiType,
        path: `${defaultUpstreamPath(apiType)}${suffix}`,
        search: new URL(c.req.url).search,
        method,
        headers: pickRequestHeaders(c.req.raw.headers),
        // Upload multipart di-stream langsung tanpa ditampung di memori.
        body: hasBody ? c.req.raw.body : undefined,
        signal: c.req.raw.signal,
        timeoutMs: rc.config.server.timeoutMs,
        fetch: rc.fetch,
      });
    } catch (err) {
      if (err instanceof UpstreamTimeoutError) throw new RouterError(504, err.message);
      if (err instanceof UpstreamNetworkError) throw new RouterError(502, err.message);
      throw err;
    }

    const headers = pickResponseHeaders(res.headers);
    headers.set('x-router-provider', provider.id);
    return new Response(res.body, { status: res.status, headers });
  };
}
