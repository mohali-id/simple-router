import { describe, expect, it } from 'vitest';
import { authed, CLIENT_KEY, jsonResponse, makeApp } from './helpers.js';

const noUpstream = () => jsonResponse({ error: 'should not be called' }, 500);

describe('server & auth (Fase 2)', () => {
  it('GET /health tanpa auth', async () => {
    const { app } = makeApp(noUpstream);
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', name: 'test-router' });
  });

  it('401 format OpenAI tanpa key', async () => {
    const { app } = makeApp(noUpstream);
    const res = await app.request('/v1/models');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { type: 'authentication_error', code: 'invalid_api_key' } });
  });

  it('401 format Anthropic di /v1/messages', async () => {
    const { app } = makeApp(noUpstream);
    const res = await app.request('/v1/messages', { method: 'POST', headers: { 'x-api-key': 'salah' } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ type: 'error', error: { type: 'authentication_error', message: expect.any(String) } });
  });

  it('menerima Bearer dan x-api-key', async () => {
    const { app } = makeApp(noUpstream);
    expect((await app.request('/v1/models', authed())).status).toBe(200);
    expect((await app.request('/v1/models', { headers: { 'x-api-key': CLIENT_KEY } })).status).toBe(200);
  });

  it('GET /v1/models me-list routes (kompatibel OpenAI & Anthropic)', async () => {
    const { app } = makeApp(noUpstream);
    const body = (await (await app.request('/v1/models', authed())).json()) as { data: Record<string, unknown>[] };
    expect(body.data.map((m) => m.id)).toEqual(['chat', 'resp', 'claude', 'combo', 'duo', 'embed', 'whisper']);
    expect(body.data[0]).toMatchObject({ object: 'model', type: 'model', display_name: 'Chat', owned_by: 'simple-router' });

    const one = await app.request('/v1/models/combo', authed());
    expect(await one.json()).toMatchObject({ id: 'combo' });
    expect((await app.request('/v1/models/nope', authed())).status).toBe(404);
  });

  it('404 untuk endpoint tak dikenal & header request id', async () => {
    const { app } = makeApp(noUpstream);
    const res = await app.request('/v1/unknown', authed({ headers: { 'x-request-id': 'abc-123' } }));
    expect(res.status).toBe(404);
    expect(res.headers.get('x-router-request-id')).toBe('abc-123');
  });

  it('400 untuk body bukan JSON / model kosong / model tak dikenal', async () => {
    const { app } = makeApp(noUpstream);
    const bad = await app.request('/v1/chat/completions', authed({ method: 'POST', body: 'x', headers: { 'content-type': 'application/json' } }));
    expect(bad.status).toBe(400);
    expect((await app.request('/v1/chat/completions', authed({ json: { messages: [] } }))).status).toBe(400);
    const unknown = await app.request('/v1/chat/completions', authed({ json: { model: 'nope', messages: [] } }));
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: 'model_not_found' } });
  });
});
