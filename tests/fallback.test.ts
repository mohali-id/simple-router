import { describe, expect, it } from 'vitest';
import { authed, jsonResponse, makeApp } from './helpers.js';

const ok = (model: string) => ({
  id: 'x',
  object: 'chat.completion',
  created: 1,
  model,
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
});

describe('fallback (Fase 4)', () => {
  it('target 1 HTTP 500 → target 2 sukses', async () => {
    const { app, calls } = makeApp((req) =>
      req.url.startsWith('https://openai.test') ? jsonResponse({ error: { message: 'boom' } }, 500) : jsonResponse(ok('b')),
    );
    const res = await app.request('/v1/chat/completions', authed({ json: { model: 'duo', messages: [] } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-router-target')).toBe('openai2/gpt-chat-b');
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['openai.test', 'openai2.test']);
  });

  it('429 dan network error juga memicu fallback', async () => {
    let n = 0;
    const { app } = makeApp(() => {
      n += 1;
      if (n === 1) return jsonResponse({ error: { message: 'slow down' } }, 429);
      return jsonResponse(ok('b'));
    });
    expect((await app.request('/v1/chat/completions', authed({ json: { model: 'duo', messages: [] } }))).status).toBe(200);

    const net = makeApp((req) => {
      if (req.url.startsWith('https://openai.test')) throw new TypeError('fetch failed');
      return jsonResponse(ok('b'));
    });
    const res = await net.app.request('/v1/chat/completions', authed({ json: { model: 'duo', messages: [] } }));
    expect(res.status).toBe(200);
  });

  it('400 dari upstream TIDAK di-fallback', async () => {
    const { app, calls } = makeApp(() => jsonResponse({ error: { message: 'bad' } }, 400));
    const res = await app.request('/v1/chat/completions', authed({ json: { model: 'duo', messages: [] } }));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it('semua target gagal → error ringkasan dengan status terakhir', async () => {
    const { app } = makeApp(() => jsonResponse({ error: { message: 'down' } }, 503));
    const res = await app.request('/v1/chat/completions', authed({ json: { model: 'duo', messages: [] } }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('semua target gagal');
    expect(body.error.message).toContain('openai/gpt-chat (503)');
  });

  it('target yang gagal di-cooldown: request berikutnya mencoba target sehat dulu', async () => {
    let fail = true;
    const { app, calls } = makeApp((req) => {
      if (req.url.startsWith('https://openai.test') && fail) return jsonResponse({ error: { message: 'x' } }, 500);
      return jsonResponse(ok('m'));
    });
    await app.request('/v1/chat/completions', authed({ json: { model: 'duo', messages: [] } }));
    fail = false;
    calls.length = 0;
    const res = await app.request('/v1/chat/completions', authed({ json: { model: 'duo', messages: [] } }));
    expect(res.headers.get('x-router-target')).toBe('openai2/gpt-chat-b');
    expect(calls).toHaveLength(1);
  });

  it('timeout upstream (sampai header) → 504 lalu fallback', async () => {
    const { app } = makeApp(
      (req) =>
        req.url.startsWith('https://openai.test')
          ? new Promise<Response>((_, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason)))
          : jsonResponse(ok('b')),
    );
    const started = Date.now();
    const res = await app.request('/v1/chat/completions', authed({ json: { model: 'duo', messages: [] } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-router-target')).toBe('openai2/gpt-chat-b');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('x-router-provider membatasi target ke provider tersebut', async () => {
    const { app, calls } = makeApp(() => jsonResponse(ok('b')));
    const res = await app.request(
      '/v1/chat/completions',
      authed({ headers: { 'x-router-provider': 'openai2' }, json: { model: 'duo', messages: [] } }),
    );
    expect(res.status).toBe(200);
    expect(new URL(calls[0]!.url).host).toBe('openai2.test');

    const bad = await app.request(
      '/v1/chat/completions',
      authed({ headers: { 'x-router-provider': 'anthropic' }, json: { model: 'duo', messages: [] } }),
    );
    expect(bad.status).toBe(400);
  });
});
