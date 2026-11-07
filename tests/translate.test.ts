import { describe, expect, it } from 'vitest';
import { anthropicRequestToHub, hubToAnthropicRequest } from '../src/translate/anthropic.js';
import { translateRequest, translateResponse } from '../src/translate/index.js';
import { hubToResponsesRequest, responsesRequestToHub } from '../src/translate/responses.js';
import { TranslationError } from '../src/translate/types.js';
import { authed, jsonResponse, makeApp } from './helpers.js';

const weatherTool = { name: 'get_weather', description: 'cuaca', input_schema: { type: 'object', properties: { city: { type: 'string' } } } };

describe('request Anthropic → hub/Chat', () => {
  const anthropicBody = {
    model: 'x',
    max_tokens: 100,
    system: [{ type: 'text', text: 'Kamu asisten.' }],
    stop_sequences: ['END'],
    tools: [weatherTool],
    tool_choice: { type: 'any', disable_parallel_tool_use: true },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Cuaca Jakarta?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Cek dulu.' }, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Jakarta' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '30C' }] }, { type: 'text', text: 'Lalu?' }] },
    ],
  };

  it('memetakan system, gambar, tool_use, tool_result, tool_choice', () => {
    const chat = translateRequest('anthropic-messages', 'openai-completions', anthropicBody, 'gpt-chat');
    expect(chat).toEqual({
      model: 'gpt-chat',
      messages: [
        { role: 'system', content: 'Kamu asisten.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Cuaca Jakarta?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
          ],
        },
        {
          role: 'assistant',
          content: 'Cek dulu.',
          tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Jakarta"}' } }],
        },
        { role: 'tool', tool_call_id: 'toolu_1', content: '30C' },
        { role: 'user', content: [{ type: 'text', text: 'Lalu?' }] },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'cuaca', parameters: weatherTool.input_schema } }],
      tool_choice: 'required',
      parallel_tool_calls: false,
      max_completion_tokens: 100,
      stop: ['END'],
    });
  });

  it('round-trip Anthropic → hub → Anthropic mempertahankan struktur', () => {
    const back = hubToAnthropicRequest(anthropicRequestToHub(anthropicBody));
    expect(back.system).toBe('Kamu asisten.');
    expect(back.tool_choice).toEqual({ type: 'any', disable_parallel_tool_use: true });
    expect(back.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Cuaca Jakarta?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Cek dulu.' }, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Jakarta' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '30C' }, { type: 'text', text: 'Lalu?' }],
      },
    ]);
  });
});

describe('request Chat → Anthropic', () => {
  it('default max_tokens, gabung pesan beruntun, tool_result di depan', () => {
    const out = translateRequest(
      'openai-completions',
      'anthropic-messages',
      {
        model: 'x',
        messages: [
          { role: 'system', content: 'S1' },
          { role: 'developer', content: 'S2' },
          { role: 'user', content: 'a' },
          { role: 'user', content: 'b' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"x":1}' } }] },
          { role: 'tool', tool_call_id: 'c1', content: 'hasil' },
        ],
        tool_choice: { type: 'function', function: { name: 'f' } },
        tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
        stop: 'X',
      },
      'claude',
    );
    expect(out).toEqual({
      model: 'claude',
      system: 'S1\n\nS2',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'f', input: { x: 1 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'hasil' }] },
      ],
      max_tokens: 4096,
      stop_sequences: ['X'],
      tools: [{ name: 'f', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'f' },
    });
  });
});

describe('request Responses ↔ hub', () => {
  it('instructions, input items, function_call(_output), text.format', () => {
    const hub = responsesRequestToHub({
      model: 'x',
      instructions: 'Sistem',
      max_output_tokens: 50,
      reasoning: { effort: 'low' },
      text: { format: { type: 'json_schema', name: 'out', schema: { type: 'object' }, strict: true } },
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'hai' }, { type: 'input_image', image_url: 'https://x/y.png' }] },
        { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
        { type: 'function_call', call_id: 'c2', name: 'g', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: 'r1' },
      ],
      tools: [{ type: 'function', name: 'f', parameters: { type: 'object' } }],
    });
    expect(hub.messages).toEqual([
      { role: 'system', content: 'Sistem' },
      { role: 'user', content: [{ type: 'text', text: 'hai' }, { type: 'image_url', image_url: { url: 'https://x/y.png' } }] },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'g', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
    ]);
    expect(hub.max_tokens).toBe(50);
    expect(hub.reasoning_effort).toBe('low');
    expect(hub.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'out', schema: { type: 'object' }, strict: true } });

    const back = hubToResponsesRequest(hub);
    expect(back).toMatchObject({
      instructions: 'Sistem',
      max_output_tokens: 50,
      reasoning: { effort: 'low' },
      text: { format: { type: 'json_schema', name: 'out', strict: true } },
      store: false,
    });
    expect(back.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hai' }, { type: 'input_image', image_url: 'https://x/y.png', detail: 'auto' }] },
      { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
      { type: 'function_call', call_id: 'c2', name: 'g', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'r1' },
    ]);
  });

  it('tool bawaan & previous_response_id tidak bisa ditranslasi', () => {
    expect(() => responsesRequestToHub({ input: 'x', tools: [{ type: 'web_search' }] })).toThrow(TranslationError);
    expect(() => responsesRequestToHub({ input: 'x', previous_response_id: 'resp_1' })).toThrow(TranslationError);
  });
});

describe('response translation', () => {
  const anthropicMsg = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude',
    content: [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'Saya cek.' },
      { type: 'tool_use', id: 'toolu_9', name: 'get_weather', input: { city: 'Bandung' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
  };

  it('Anthropic → Chat', () => {
    const chat = translateResponse('anthropic-messages', 'openai-completions', anthropicMsg);
    expect(chat).toMatchObject({
      object: 'chat.completion',
      model: 'claude',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Saya cek.',
            reasoning_content: 'hmm',
            tool_calls: [{ id: 'toolu_9', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Bandung"}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    });
  });

  it('Anthropic → Responses', () => {
    const resp = translateResponse('anthropic-messages', 'openai-responses', anthropicMsg);
    expect(resp).toMatchObject({
      object: 'response',
      status: 'completed',
      output_text: 'Saya cek.',
      usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
    });
    const types = (resp.output as { type: string }[]).map((o) => o.type);
    expect(types).toEqual(['reasoning', 'message', 'function_call']);
    expect((resp.output as Record<string, unknown>[])[2]).toMatchObject({ call_id: 'toolu_9', name: 'get_weather' });
  });

  it('Responses (incomplete) → Anthropic', () => {
    const msg = translateResponse('openai-responses', 'anthropic-messages', {
      id: 'resp_1',
      object: 'response',
      model: 'gpt-resp',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'potong' }] }],
      usage: { input_tokens: 4, output_tokens: 9, total_tokens: 13 },
    });
    expect(msg).toMatchObject({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'potong' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 4, output_tokens: 9 },
    });
    expect(String(msg.id)).toMatch(/^msg_/);
  });

  it('Chat → Anthropic dengan tool_calls', () => {
    const msg = translateResponse('openai-completions', 'anthropic-messages', {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1,
      model: 'gpt',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] },
          finish_reason: 'tool_calls',
        },
      ],
    });
    expect(msg.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'f', input: { a: 1 } }]);
    expect(msg.stop_reason).toBe('tool_use');
  });
});

describe('translasi end-to-end lewat router (Fase 6)', () => {
  it('/v1/messages → upstream OpenAI Responses → balik format Anthropic', async () => {
    const { app, calls } = makeApp(() =>
      jsonResponse({
        id: 'resp_1',
        object: 'response',
        model: 'gpt-resp',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Halo!' }] }],
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      }),
    );
    const res = await app.request(
      '/v1/messages',
      authed({ json: { model: 'resp', max_tokens: 20, system: 'S', messages: [{ role: 'user', content: 'hai' }] } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ type: 'message', content: [{ type: 'text', text: 'Halo!' }], stop_reason: 'end_turn' });
    expect(calls[0]!.url).toBe('https://openai.test/v1/responses');
    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      model: 'gpt-resp',
      instructions: 'S',
      max_output_tokens: 20,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hai' }] }],
    });
  });

  it('metadata.user_id panjang (Claude Code) di-hash jadi ≤64 karakter untuk OpenAI', async () => {
    const longId = `user_${'a'.repeat(64)}_account_${'b'.repeat(36)}_session_${'c'.repeat(20)}`;
    expect(longId.length).toBeGreaterThan(64);
    const { app, calls } = makeApp(() =>
      jsonResponse({ id: 'resp_1', object: 'response', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } }),
    );
    const send = (model: string, userId: string) =>
      app.request(
        '/v1/messages',
        authed({ json: { model, max_tokens: 10, metadata: { user_id: userId }, messages: [{ role: 'user', content: 'halo' }] } }),
      );

    expect((await send('resp', longId)).status).toBe(200);
    const user = JSON.parse(calls[0]!.body).user as string;
    expect(user).toMatch(/^[0-9a-f]{64}$/);

    await send('resp', longId); // stabil: id sama → hash sama
    expect(JSON.parse(calls[1]!.body).user).toBe(user);

    await send('resp', 'user-pendek'); // ≤64 diteruskan apa adanya
    expect(JSON.parse(calls[2]!.body).user).toBe('user-pendek');

    await send('chat', longId); // berlaku juga untuk upstream Chat Completions
    expect(JSON.parse(calls[3]!.body).user).toBe(user);
  });

  it('error 4xx upstream ditranslasi ke format inbound', async () => {
    const { app } = makeApp(() => jsonResponse({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt terlalu panjang' } }, 400));
    const res = await app.request('/v1/chat/completions', authed({ json: { model: 'claude', messages: [{ role: 'user', content: 'x' }] } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { message: 'prompt terlalu panjang', type: 'invalid_request_error' } });
  });

  it('fitur yang tidak bisa ditranslasi → target dilewati, fallback ke format yang sama', async () => {
    const config = (await import('./helpers.js')).TEST_CONFIG.replace(
      '  - { id: embed, models',
      '  - { id: mix, models: [anthropic/claude, openai/gpt-resp] }\n  - { id: embed, models',
    );
    const { app, calls } = makeApp(() => jsonResponse({ id: 'resp_2', object: 'response', status: 'completed', output: [] }), { config });
    const res = await app.request('/v1/responses', authed({ json: { model: 'mix', input: 'cari', tools: [{ type: 'web_search' }] } }));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://openai.test/v1/responses');
  });
});
