import { describe, expect, it } from 'vitest';
import { authed, jsonResponse, makeApp, sseEvents, sseResponse, TEST_CONFIG } from './helpers.js';

const CONFIG = TEST_CONFIG.replace('server:\n', 'server:\n  base-path: /router\n');

const chat = { id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] };

describe('server.base-path', () => {
  it('endpoint dilayani di bawah prefix, tanpa prefix → 404', async () => {
    const { app, calls } = makeApp(() => jsonResponse(chat), { config: CONFIG });
    const ok = await app.request('/router/v1/chat/completions', authed({ json: { model: 'chat', messages: [] } }));
    expect(ok.status).toBe(200);
    expect(calls[0]!.url).toBe('https://openai.test/v1/chat/completions'); // prefix tidak ikut ke upstream

    const missing = await app.request('/v1/chat/completions', authed({ json: { model: 'chat', messages: [] } }));
    expect(missing.status).toBe(404);
    expect(calls).toHaveLength(1);
    // Prefix harus utuh per segmen.
    expect((await app.request('/routerx/v1/models', authed())).status).toBe(404);
  });

  it('models, api/hello, health di bawah prefix; health juga di root', async () => {
    const { app } = makeApp(() => jsonResponse({}), { config: CONFIG });
    expect((await app.request('/router/v1/models', authed())).status).toBe(200);
    expect((await app.request('/router/api/hello', { method: 'HEAD' })).status).toBe(200);
    expect((await app.request('/router/health')).status).toBe(200);
    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/api/hello')).status).toBe(404);
  });

  it('auth & format error Anthropic tetap jalan di bawah prefix', async () => {
    const { app } = makeApp(() => jsonResponse({}), { config: CONFIG });
    const res = await app.request('/router/v1/messages', { method: 'POST', headers: { 'x-api-key': 'salah' } });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ type: 'error', error: { type: 'authentication_error' } });
  });

  it('stream & upload multipart (body stream) lewat prefix', async () => {
    const pieces = sseEvents([{ data: { choices: [{ index: 0, delta: { content: 'hi' } }] } }, { data: '[DONE]' }]);
    const { app, calls } = makeApp((req) => (req.url.endsWith('/files') ? jsonResponse({ id: 'file-1' }) : sseResponse(pieces)), {
      config: CONFIG,
    });
    const stream = await app.request('/router/v1/chat/completions', authed({ json: { model: 'chat', stream: true, messages: [] } }));
    expect(await stream.text()).toBe(pieces.join(''));

    const form = new FormData();
    form.append('purpose', 'assistants');
    form.append('file', new Blob(['ISI-FILE']), 'a.txt');
    const up = await app.request('/router/v1/files', authed({ method: 'POST', body: form }));
    expect(up.status).toBe(200);
    expect(calls.at(-1)!.url).toBe('https://openai.test/v1/files');
    expect(calls.at(-1)!.body).toContain('ISI-FILE');
  });

  it('sub-path files & query string tetap utuh', async () => {
    const { app, calls } = makeApp(() => jsonResponse({}), { config: CONFIG });
    await app.request('/router/v1/files/file-1/content?x=1', authed());
    expect(calls[0]!.url).toBe('https://openai.test/v1/files/file-1/content?x=1');
  });
});
