import { describe, expect, it } from 'vitest';
import { authed, jsonResponse, makeApp, TEST_CONFIG } from './helpers.js';

describe('files & vector stores (Fase 5)', () => {
  it('upload multipart ke provider default, boundary & isi utuh', async () => {
    const { app, calls } = makeApp(() => jsonResponse({ id: 'file-abc', object: 'file' }));
    const form = new FormData();
    form.append('purpose', 'assistants');
    form.append('file', new Blob(['%PDF-1.4 isi'], { type: 'application/pdf' }), 'doc.pdf');
    const res = await app.request('/v1/files', authed({ method: 'POST', body: form }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'file-abc', object: 'file' });
    expect(res.headers.get('x-router-provider')).toBe('openai');
    const call = calls[0]!;
    expect(call.url).toBe('https://openai.test/v1/files');
    expect(call.headers.get('authorization')).toBe('Bearer sk-openai-upstream');
    const boundary = /boundary=(.+)$/.exec(call.headers.get('content-type') ?? '')?.[1];
    expect(boundary).toBeTruthy();
    expect(call.body).toContain(`--${boundary}`);
    expect(call.body).toContain('%PDF-1.4 isi');
  });

  it('list dengan query string, get, delete, download content', async () => {
    const { app, calls } = makeApp((req) =>
      req.url.endsWith('/content')
        ? new Response('BYTES', { headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="a.bin"' } })
        : jsonResponse({ ok: true }),
    );
    await app.request('/v1/files?limit=2&purpose=assistants', authed());
    await app.request('/v1/files/file-1', authed());
    await app.request('/v1/files/file-1', authed({ method: 'DELETE' }));
    const content = await app.request('/v1/files/file-1/content', authed());

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://openai.test/v1/files?limit=2&purpose=assistants',
      'GET https://openai.test/v1/files/file-1',
      'DELETE https://openai.test/v1/files/file-1',
      'GET https://openai.test/v1/files/file-1/content',
    ]);
    expect(await content.text()).toBe('BYTES');
    expect(content.headers.get('content-disposition')).toContain('a.bin');
  });

  it('x-router-provider: anthropic → header Files API beta', async () => {
    const { app, calls } = makeApp(() => jsonResponse({ data: [] }));
    await app.request('/v1/files', authed({ headers: { 'x-router-provider': 'anthropic', 'anthropic-beta': 'other-beta' } }));
    const call = calls[0]!;
    expect(call.url).toBe('https://anthropic.test/v1/files');
    expect(call.headers.get('x-api-key')).toBe('sk-ant-upstream');
    expect(call.headers.get('anthropic-beta')).toBe('other-beta,files-api-2025-04-14');
    expect(call.headers.get('authorization')).toBeNull();
  });

  it('vector stores: CRUD, sub-path, search', async () => {
    const { app, calls } = makeApp(() => jsonResponse({ ok: true }));
    await app.request('/v1/vector_stores', authed({ json: { name: 'docs', file_ids: ['file-1'] } }));
    await app.request('/v1/vector_stores/vs_1/files?limit=5', authed());
    await app.request('/v1/vector_stores/vs_1/search', authed({ json: { query: 'apa' } }));
    await app.request('/v1/vector_stores/vs_1/file_batches/b1/cancel', authed({ method: 'POST' }));
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://openai.test/v1/vector_stores',
      'GET https://openai.test/v1/vector_stores/vs_1/files?limit=5',
      'POST https://openai.test/v1/vector_stores/vs_1/search',
      'POST https://openai.test/v1/vector_stores/vs_1/file_batches/b1/cancel',
    ]);
    expect(JSON.parse(calls[0]!.body)).toEqual({ name: 'docs', file_ids: ['file-1'] });
  });

  it('error upstream (404) diteruskan tanpa fallback', async () => {
    const { app, calls } = makeApp(() => jsonResponse({ error: { message: 'No such file' } }, 404));
    const res = await app.request('/v1/files/file-x', authed());
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it('vector store ke provider anthropic → 400', async () => {
    const { app, calls } = makeApp(() => jsonResponse({}));
    const res = await app.request('/v1/vector_stores', authed({ headers: { 'x-router-provider': 'anthropic' } }));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('tanpa provider default & tanpa header → 400 provider_required', async () => {
    const config = TEST_CONFIG.replace(/  resources:\n.*\n.*\n/, '');
    const { app } = makeApp(() => jsonResponse({}), { config });
    const res = await app.request('/v1/files', authed());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'provider_required' } });

    const unknown = await app.request('/v1/files', authed({ headers: { 'x-router-provider': 'ghost' } }));
    expect(unknown.status).toBe(400);
  });
});
