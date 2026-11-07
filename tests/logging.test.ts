import { describe, expect, it } from 'vitest';
import { authed, captureLogger, jsonResponse, makeApp, sseEvents, sseResponse } from './helpers.js';

const anthropicStream = sseEvents([
  { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_1', model: 'claude', usage: { input_tokens: 1 } } } },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'RAHASIA-JAWABAN' } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

describe('logging request', () => {
  it('non-stream: request start lalu request done', async () => {
    const logger = captureLogger();
    const { app } = makeApp(() => jsonResponse({ id: 'x', object: 'chat.completion', choices: [] }), { logger });
    await app.request('/v1/chat/completions', authed({ json: { model: 'chat', messages: [] } }));

    const info = logger.lines.filter((l) => l.level === 'info');
    expect(info.map((l) => l.msg)).toEqual(['request start', 'request done']);
    expect(info[0]!.fields).toMatchObject({ method: 'POST', path: '/v1/chat/completions' });
    expect(info[1]!.fields).toMatchObject({ status: 200, route: 'chat', target: 'openai/gpt-chat', ms: expect.any(Number) });
    expect(info[0]!.fields.req).toBe(info[1]!.fields.req);
  });

  it('stream: start, first event, tiap event (debug), done — tanpa isi event', async () => {
    const logger = captureLogger();
    const { app } = makeApp(() => sseResponse(anthropicStream), { logger });
    const res = await app.request('/v1/messages', authed({ json: { model: 'claude', max_tokens: 5, stream: true, messages: [] } }));
    await res.text();

    const msgs = logger.lines.map((l) => `${l.level}:${l.msg}`);
    expect(msgs.filter((m) => m.startsWith('info:'))).toEqual([
      'info:request start',
      'info:stream start',
      'info:stream first event',
      'info:stream done',
    ]);
    const events = logger.lines.filter((l) => l.msg === 'stream event');
    expect(events.map((l) => l.fields.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(events.every((l) => l.level === 'debug')).toBe(true);

    const done = logger.lines.find((l) => l.msg === 'stream done')!;
    expect(done.fields).toMatchObject({ outcome: 'completed', events: 6, route: 'claude', target: 'anthropic/claude', ms: expect.any(Number) });
    expect(done.fields.bytes).toBe(anthropicStream.join('').length);
    expect(JSON.stringify(logger.lines)).not.toContain('RAHASIA-JAWABAN');
  });

  it('stream Chat tanpa nama event: chunk & done dikenali', async () => {
    const logger = captureLogger();
    const pieces = sseEvents([{ data: { choices: [{ index: 0, delta: { content: 'a' } }] } }, { data: '[DONE]' }]);
    const { app } = makeApp(() => sseResponse(pieces), { logger });
    await (await app.request('/v1/chat/completions', authed({ json: { model: 'chat', stream: true, messages: [] } }))).text();
    expect(logger.lines.filter((l) => l.msg === 'stream event').map((l) => l.fields.event)).toEqual(['chunk', 'done']);
  });

  it('stream dibatalkan client → stream done outcome=aborted (warn)', async () => {
    const logger = captureLogger();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(anthropicStream[0]!)); // lalu tidak pernah selesai
      },
    });
    const { app } = makeApp(() => new Response(body, { headers: { 'content-type': 'text/event-stream' } }), { logger });
    const res = await app.request('/v1/messages', authed({ json: { model: 'claude', max_tokens: 5, stream: true, messages: [] } }));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();

    const done = logger.lines.find((l) => l.msg === 'stream done')!;
    expect(done.level).toBe('warn');
    expect(done.fields.outcome).toBe('aborted');
  });

  it('error di tengah stream → outcome completed_with_error', async () => {
    const logger = captureLogger();
    const upstream = sseEvents([
      { event: 'message_start', data: { type: 'message_start', message: { id: 'm', model: 'c' } } },
      { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } },
    ]);
    const { app } = makeApp(() => sseResponse(upstream), { logger });
    await (await app.request('/v1/chat/completions', authed({ json: { model: 'claude', stream: true, messages: [] } }))).text();
    const done = logger.lines.find((l) => l.msg === 'stream done')!;
    expect(done.level).toBe('warn');
    expect(done.fields.outcome).toBe('completed_with_error');
  });

  it('/health dan /api/hello tidak dicatat', async () => {
    const logger = captureLogger();
    const { app } = makeApp(() => jsonResponse({}), { logger });
    await app.request('/health');
    await app.request('/api/hello', { method: 'HEAD' });
    expect(logger.lines).toHaveLength(0);
  });
});
