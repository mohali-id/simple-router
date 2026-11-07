import { describe, expect, it } from 'vitest';
import { authed, CLIENT_KEY, jsonResponse, makeApp, readSse, sseEvents, sseResponse } from './helpers.js';

const chatCompletion = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-chat',
  choices: [{ index: 0, message: { role: 'assistant', content: 'halo' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
};

describe('passthrough (Fase 3)', () => {
  it('chat completions: ganti model & auth, body respons diteruskan', async () => {
    const { app, calls } = makeApp(() => jsonResponse(chatCompletion, 200, { 'x-request-id': 'up-1', 'set-cookie': 'x=1' }));
    const res = await app.request('/v1/chat/completions', authed({ json: { model: 'chat', messages: [{ role: 'user', content: 'hi' }], foo: 1 } }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(chatCompletion);
    expect(res.headers.get('x-router-target')).toBe('openai/gpt-chat');
    expect(res.headers.get('x-router-route')).toBe('chat');
    expect(res.headers.get('x-request-id')).toBe('up-1');
    expect(res.headers.get('set-cookie')).toBeNull();

    const call = calls[0]!;
    expect(call.url).toBe('https://openai.test/v1/chat/completions');
    expect(call.headers.get('authorization')).toBe('Bearer sk-openai-upstream');
    expect(call.body).not.toContain(CLIENT_KEY);
    expect(JSON.parse(call.body)).toEqual({ model: 'gpt-chat', messages: [{ role: 'user', content: 'hi' }], foo: 1 });
  });

  it('model bisa dipanggil langsung sebagai provider/model', async () => {
    const { app, calls } = makeApp(() => jsonResponse(chatCompletion));
    const res = await app.request('/v1/chat/completions', authed({ json: { model: 'openai/gpt-chat', messages: [] } }));
    expect(res.status).toBe(200);
    expect(JSON.parse(calls[0]!.body).model).toBe('gpt-chat');
  });

  it('anthropic messages: header x-api-key + anthropic-version, beta diteruskan', async () => {
    const msg = { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
    const { app, calls } = makeApp(() => jsonResponse(msg));
    const res = await app.request(
      '/v1/messages',
      authed({
        headers: { 'x-api-key': CLIENT_KEY, 'anthropic-beta': 'foo-2025' },
        json: { model: 'claude', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      }),
    );
    expect(await res.json()).toEqual(msg);
    const call = calls[0]!;
    expect(call.url).toBe('https://anthropic.test/v1/messages');
    expect(call.headers.get('x-api-key')).toBe('sk-ant-upstream');
    expect(call.headers.get('authorization')).toBeNull();
    expect(call.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(call.headers.get('anthropic-beta')).toBe('foo-2025');
  });

  it('streaming format sama diteruskan byte-per-byte', async () => {
    const pieces = sseEvents([
      { data: { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'ha' }, finish_reason: null }] } },
      { data: { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }] } },
      { data: '[DONE]' },
    ]);
    const { app } = makeApp(() => sseResponse(pieces));
    const res = await app.request('/v1/chat/completions', authed({ json: { model: 'chat', stream: true, messages: [] } }));
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(await res.text()).toBe(pieces.join(''));
  });

  it('error 4xx upstream format sama diteruskan apa adanya', async () => {
    const { app } = makeApp(() => jsonResponse({ error: { message: 'bad param', type: 'invalid_request_error' } }, 400));
    const res = await app.request('/v1/chat/completions', authed({ json: { model: 'chat', messages: [] } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { message: 'bad param', type: 'invalid_request_error' } });
  });

  it('embeddings JSON', async () => {
    const { app, calls } = makeApp(() => jsonResponse({ object: 'list', data: [] }));
    const res = await app.request('/v1/embeddings', authed({ json: { model: 'embed', input: 'x' } }));
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toBe('https://openai.test/v1/embeddings');
    expect(JSON.parse(calls[0]!.body)).toEqual({ model: 'embed', input: 'x' });
  });

  it('audio transcriptions multipart: model diganti, file ikut', async () => {
    const { app, calls } = makeApp(() => jsonResponse({ text: 'halo' }));
    const form = new FormData();
    form.append('model', 'whisper');
    form.append('file', new Blob(['RIFF-audio'], { type: 'audio/wav' }), 'a.wav');
    const res = await app.request('/v1/audio/transcriptions', authed({ method: 'POST', body: form }));
    expect(res.status).toBe(200);
    const call = calls[0]!;
    expect(call.url).toBe('https://openai.test/v1/audio/transcriptions');
    expect(call.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
    expect(call.body).toContain('name="model"\r\n\r\nwhisper\r\n');
    expect(call.body).toContain('RIFF-audio');
  });

  it('model dengan api-type lain ditolak di endpoint chat', async () => {
    const { app, calls } = makeApp(() => jsonResponse({}));
    const res = await app.request('/v1/chat/completions', authed({ json: { model: 'embed', messages: [] } }));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
    expect(await res.json()).toMatchObject({ error: { message: expect.stringContaining('tidak melayani') } });
  });

  it('respons stream diakhiri [DONE] bisa dibaca helper', async () => {
    const { app } = makeApp(() => sseResponse(sseEvents([{ data: '[DONE]' }])));
    const res = await app.request('/v1/chat/completions', authed({ json: { model: 'chat', stream: true, messages: [] } }));
    expect(await readSse(res)).toEqual([{ event: undefined, data: '[DONE]' }]);
  });
});
