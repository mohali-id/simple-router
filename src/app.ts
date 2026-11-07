import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { extractClientKey, matchClientKey } from './auth.js';
import type { ApiType, Config, Endpoint } from './config/index.js';
import type { AppEnv, RouterContext } from './context.js';
import { errorResponse, type ErrorFormat, RouterError } from './errors.js';
import { createLogger, type Logger } from './logger.js';
import { createChatHandler } from './routes/chat.js';
import { createModelPassthroughHandler } from './routes/model-passthrough.js';
import { createResourceHandler } from './routes/resources.js';
import { createState, type RouterState } from './state.js';
import { logStream } from './stream-log.js';
import { isChatFormat } from './translate/index.js';

/** Dipakai bila `application.endpoints` di config kosong. */
export const DEFAULT_ENDPOINTS: Endpoint[] = [
  { id: 'openai-completions', url: '/v1/chat/completions', methods: ['POST'] },
  { id: 'openai-responses', url: '/v1/responses', methods: ['POST'] },
  { id: 'anthropic-messages', url: '/v1/messages', methods: ['POST'] },
  { id: 'openai-images', url: '/v1/images/generations', methods: ['POST'] },
  { id: 'openai-images', url: '/v1/images/edits', methods: ['POST'] },
  { id: 'openai-audio', url: '/v1/audio/speech', methods: ['POST'] },
  { id: 'openai-audio', url: '/v1/audio/transcriptions', methods: ['POST'] },
  { id: 'openai-audio', url: '/v1/audio/translations', methods: ['POST'] },
  { id: 'openai-embeddings', url: '/v1/embeddings', methods: ['POST'] },
  { id: 'openai-moderation', url: '/v1/moderations', methods: ['POST'] },
  { id: 'openai-files', url: '/v1/files', methods: ['GET', 'POST', 'DELETE'] },
  { id: 'openai-vector-stores', url: '/v1/vector_stores', methods: ['GET', 'POST', 'DELETE'] },
];

/** Endpoint publik yang sering dipanggil dan tidak perlu dicatat di log. */
const QUIET_PATHS = new Set(['/health', '/api/hello']);

export interface AppDeps {
  fetch?: typeof fetch;
  logger?: Logger;
  /** State bersama (cooldown) agar bertahan saat config di-reload. */
  state?: RouterState;
}

function errorFormatOf(apiType: ApiType): ErrorFormat {
  return apiType === 'anthropic-messages' ? 'anthropic' : 'openai';
}

function modelList(config: Config) {
  const created = Math.floor(Date.now() / 1000);
  const createdAt = new Date(created * 1000).toISOString();
  // Gabungan format OpenAI (`object`, `owned_by`) dan Anthropic (`type`, `display_name`).
  const data = config.routes.map((r) => ({
    id: r.id,
    object: 'model',
    type: 'model',
    created,
    created_at: createdAt,
    owned_by: 'simple-router',
    display_name: r.name ?? r.id,
  }));
  return { object: 'list', data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null };
}

export function createApp(config: Config, deps: AppDeps = {}): Hono<AppEnv> {
  const rc: RouterContext = {
    config,
    state: deps.state ?? createState(),
    logger: deps.logger ?? createLogger(),
    fetch: deps.fetch ?? globalThis.fetch,
  };
  const endpoints = config.application.endpoints.length ? config.application.endpoints : DEFAULT_ENDPOINTS;
  const anthropicPaths = new Set(endpoints.filter((e) => errorFormatOf(e.id) === 'anthropic').map((e) => e.url));

  const app = new Hono<AppEnv>();

  // --- request id, format error, logging --------------------------------
  app.use('*', async (c, next) => {
    const reqId = c.req.header('x-request-id')?.slice(0, 64) || randomUUID();
    c.set('reqId', reqId);
    c.set('errorFormat', anthropicPaths.has(c.req.path) ? 'anthropic' : 'openai');
    const started = performance.now();
    const quiet = QUIET_PATHS.has(c.req.path);
    if (!quiet) rc.logger.info('request start', { req: reqId, method: c.req.method, path: c.req.path });

    await next();
    c.res.headers.set('x-router-request-id', reqId);
    if (quiet) return;

    const fields = {
      req: reqId,
      method: c.req.method,
      path: c.req.path,
      route: c.get('route'),
      target: c.get('target'),
      fallbacks: c.get('fallbacks') || undefined,
    };
    const isStream = c.res.ok && c.res.body !== null && (c.res.headers.get('content-type') ?? '').includes('text/event-stream');

    if (!isStream) {
      rc.logger.info('request done', { ...fields, status: c.res.status, ms: Math.round(performance.now() - started) });
      return;
    }

    // Stream: header sudah siap, body baru mengalir. Akhir stream dicatat oleh logStream.
    rc.logger.info('stream start', { ...fields, status: c.res.status, header_ms: Math.round(performance.now() - started) });
    const res = c.res;
    c.res = undefined; // lepas respons lama agar Hono tidak menggabungkan header
    c.res = new Response(
      logStream(res.body!, { logger: rc.logger, fields: { req: reqId, route: fields.route, target: fields.target }, startedAt: started }),
      { status: res.status, statusText: res.statusText, headers: res.headers },
    );
  });

  app.onError((err, c) => {
    const format = c.get('errorFormat') ?? 'openai';
    if (err instanceof RouterError) return errorResponse(format, err.status, err.message, err.code);
    rc.logger.error('unhandled error', { req: c.get('reqId'), reason: err instanceof Error ? err.message : String(err) });
    return errorResponse(format, 500, 'internal router error', 'internal_error');
  });

  app.notFound((c) => errorResponse(c.get('errorFormat') ?? 'openai', 404, `endpoint ${c.req.method} ${c.req.path} tidak ada`));

  // --- publik ------------------------------------------------------------
  app.get('/health', (c) => c.json({ status: 'ok', name: config.application.name, version: config.application.version ?? null }));
  // Cek koneksi yang dikirim Claude Code ke ANTHROPIC_BASE_URL (meniru api.anthropic.com). GET juga melayani HEAD.
  app.get('/api/hello', (c) => c.json({ message: 'hello' }));

  // --- auth untuk semua endpoint lain -------------------------------------
  app.use('*', async (c, next) => {
    const client = matchClientKey(config.application.auth, extractClientKey(c.req.raw.headers));
    if (!client) throw new RouterError(401, 'API key tidak valid atau tidak dikirim');
    await next();
  });

  app.get('/v1/models', (c) => c.json(modelList(config)));
  app.get('/v1/models/:id', (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    const model = modelList(config).data.find((m) => m.id === id);
    if (!model) throw new RouterError(404, `model "${id}" tidak ditemukan`, 'model_not_found');
    return c.json(model);
  });

  // --- endpoint dari config ----------------------------------------------
  for (const endpoint of endpoints) {
    const { id, url, methods } = endpoint;
    if (id === 'openai-files' || id === 'anthropic-files' || id === 'openai-vector-stores') {
      const kind = id === 'openai-vector-stores' ? 'vector-stores' : 'files';
      const handler = createResourceHandler(rc, kind, url);
      // Sub-path (/:id, /:id/content, ...) butuh semua method umum.
      const allMethods = [...new Set([...methods, 'GET', 'POST', 'DELETE'])];
      app.on(allMethods, url, handler);
      app.on(allMethods, `${url}/*`, handler);
    } else if (isChatFormat(id)) {
      app.on(methods, url, createChatHandler(rc, id));
    } else {
      app.on(methods, url, createModelPassthroughHandler(rc, id));
    }
  }

  return app;
}
