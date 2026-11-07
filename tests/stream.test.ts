import { describe, expect, it } from 'vitest';
import { parseSse } from '../src/sse.js';
import { authed, makeApp, readSse, sseEvents, sseResponse } from './helpers.js';

const chatChunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) => ({
  data: { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'gpt-chat', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) },
});

/** Stream Anthropic: teks lalu tool_use. */
const anthropicStream = sseEvents([
  { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_A', model: 'claude', usage: { input_tokens: 11, output_tokens: 0 } } } },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { event: 'ping', data: { type: 'ping' } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Sebentar' } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"Jakarta"}' } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
  { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } } },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

describe('parseSse', () => {
  it('menangani CRLF, chunk terpotong, komentar, multi-line data', async () => {
    const text = ': keep-alive\r\nevent: a\r\ndata: {"x":\r\ndata: 1}\r\n\r\ndata: dua\n\n';
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of text) c.enqueue(encoder.encode(ch)); // 1 karakter per chunk
        c.close();
      },
    });
    const events = [];
    for await (const ev of parseSse(stream)) events.push(ev);
    expect(events).toEqual([
      { event: 'a', data: '{"x":\n1}' },
      { event: undefined, data: 'dua' },
    ]);
  });
});

describe('translasi streaming (Fase 7)', () => {
  it('upstream Anthropic → client Chat Completions (teks + tool call + usage)', async () => {
    const { app, calls } = makeApp(() => sseResponse(anthropicStream));
    const res = await app.request(
      '/v1/chat/completions',
      authed({ json: { model: 'claude', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'cuaca?' }] } }),
    );
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ stream: true, max_tokens: 4096 });

    const events = await readSse(res);
    expect(events.at(-1)?.data).toBe('[DONE]');
    const chunks = events.slice(0, -1).map((e) => e.data);
    const text = chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('');
    expect(text).toBe('Sebentar');
    const toolDeltas = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []);
    expect(toolDeltas[0]).toMatchObject({ index: 0, id: 'toolu_1', function: { name: 'get_weather' } });
    expect(toolDeltas.map((t: any) => t.function.arguments).join('')).toBe('{"city":"Jakarta"}');
    const last = chunks.at(-1);
    expect(last.choices[0].finish_reason).toBe('tool_calls');
    expect(last.usage).toEqual({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
    expect(new Set(chunks.map((c) => c.id)).size).toBe(1);
  });

  it('usage tidak dikirim ke client Chat bila tidak diminta', async () => {
    const { app } = makeApp(() => sseResponse(anthropicStream));
    const res = await app.request('/v1/chat/completions', authed({ json: { model: 'claude', stream: true, messages: [] } }));
    const chunks = (await readSse(res)).slice(0, -1).map((e) => e.data);
    expect(chunks.every((c) => c.usage === undefined)).toBe(true);
  });

  it('upstream Chat → client Anthropic: urutan event valid', async () => {
    const upstream = sseEvents([
      chatChunk({ role: 'assistant', content: '' }),
      chatChunk({ content: 'Ha' }),
      chatChunk({ content: 'lo' }),
      chatChunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'f', arguments: '' } }] }),
      chatChunk({ tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] }),
      chatChunk({}, 'tool_calls'),
      { data: { id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } } },
      { data: '[DONE]' },
    ]);
    const { app, calls } = makeApp(() => sseResponse(upstream));
    const res = await app.request('/v1/messages', authed({ json: { model: 'chat', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'x' }] } }));
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ stream: true, stream_options: { include_usage: true }, max_completion_tokens: 50 });

    const events = await readSse(res);
    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(events.every((e) => e.event === e.data.type)).toBe(true);
    expect(events[1]!.data).toEqual({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    expect(events[5]!.data).toEqual({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'f', input: {} } });
    expect(events[6]!.data.delta).toEqual({ type: 'input_json_delta', partial_json: '{"a":1}' });
    expect(events[8]!.data).toMatchObject({ delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } });
  });

  it('upstream Anthropic → client Responses: event & response.completed', async () => {
    const { app } = makeApp(() => sseResponse(anthropicStream));
    const res = await app.request('/v1/responses', authed({ json: { model: 'claude', stream: true, input: 'cuaca?' } }));
    const events = await readSse(res);
    const types = events.map((e) => e.event);
    expect(types[0]).toBe('response.created');
    expect(types).toContain('response.output_text.delta');
    expect(types).toContain('response.function_call_arguments.delta');
    expect(types.at(-1)).toBe('response.completed');
    const seq = events.map((e) => e.data.sequence_number);
    expect(seq).toEqual([...seq].sort((a, b) => a - b));

    const final = events.at(-1)!.data.response;
    expect(final.status).toBe('completed');
    expect(final.output_text).toBe('Sebentar');
    expect(final.output.map((o: any) => o.type)).toEqual(['message', 'function_call']);
    expect(final.output[1]).toMatchObject({ call_id: 'toolu_1', name: 'get_weather', arguments: '{"city":"Jakarta"}' });
    expect(final.usage).toEqual({ input_tokens: 11, output_tokens: 7, total_tokens: 18 });
  });

  it('upstream Responses → client Anthropic', async () => {
    const upstream = sseEvents([
      { event: 'response.created', data: { type: 'response.created', response: { id: 'resp_1', model: 'gpt-resp' } } },
      { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1' } } },
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', item_id: 'm1', delta: 'Hai' } },
      { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc1', call_id: 'call_x', name: 'f' } } },
      { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{}' } },
      { event: 'response.completed', data: { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 2, output_tokens: 4 } } } },
    ]);
    const { app } = makeApp(() => sseResponse(upstream));
    const res = await app.request('/v1/messages', authed({ json: { model: 'resp', max_tokens: 9, stream: true, messages: [{ role: 'user', content: 'x' }] } }));
    const events = await readSse(res);
    const deltas = events.filter((e) => e.event === 'content_block_delta').map((e) => e.data.delta);
    expect(deltas).toEqual([
      { type: 'text_delta', text: 'Hai' },
      { type: 'input_json_delta', partial_json: '{}' },
    ]);
    expect(events.find((e) => e.event === 'message_delta')!.data).toMatchObject({ delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } });
    expect(events.at(-1)!.event).toBe('message_stop');
  });

  it('error di tengah stream → event error format inbound', async () => {
    const upstream = sseEvents([
      { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_1', model: 'claude' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a' } } },
      { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } },
    ]);
    const { app } = makeApp(() => sseResponse(upstream));
    const res = await app.request('/v1/chat/completions', authed({ json: { model: 'claude', stream: true, messages: [] } }));
    expect(res.status).toBe(200);
    const events = await readSse(res);
    expect(events.at(-2)!.data).toMatchObject({ error: { message: 'Overloaded' } });
    expect(events.at(-1)!.data).toBe('[DONE]');
  });

  it('stream di-forward bertahap, bukan setelah upstream selesai', async () => {
    const encoder = new TextEncoder();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(encoder.encode(anthropicStream.slice(0, 4).join('')));
        await gate;
        c.enqueue(encoder.encode(anthropicStream.slice(4).join('')));
        c.close();
      },
    });
    const { app } = makeApp(() => new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    const res = await app.request('/v1/chat/completions', authed({ json: { model: 'claude', stream: true, messages: [] } }));
    const reader = res.body!.getReader();
    // Upstream masih tertahan di `gate`; teks harus sudah sampai ke client.
    let first = '';
    while (!first.includes('Sebentar')) first += new TextDecoder().decode((await reader.read()).value);
    expect(first).not.toContain('[DONE]');
    release();
    let rest = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain('[DONE]');
  });
});
