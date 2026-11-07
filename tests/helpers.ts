import { createApp } from '../src/app.js';
import { parseConfig } from '../src/config/index.js';
import { silentLogger } from '../src/logger.js';
import { createState, type RouterState } from '../src/state.js';

export const CLIENT_KEY = 'sk-client-test-key';

export const TEST_CONFIG = `
server:
  timeout-ms: 200
  cooldown-ms: 60000
application:
  name: test-router
  auth:
    - { type: api-key, name: test, key: ${CLIENT_KEY} }
  resources:
    files: { provider: openai }
    vector-stores: { provider: openai }
providers:
  - { id: openai, base-url: https://openai.test/v1, api-key: sk-openai-upstream }
  - { id: openai2, base-url: https://openai2.test/v1, api-key: sk-openai2-upstream }
  - { id: anthropic, type: anthropic, base-url: https://anthropic.test/v1, api-key: sk-ant-upstream }
models:
  - { id: gpt-chat, provider: openai, api-type: openai-completions }
  - { id: gpt-chat-b, provider: openai2, api-type: openai-completions }
  - { id: gpt-resp, provider: openai, api-type: openai-responses }
  - { id: claude, provider: anthropic, api-type: anthropic-messages }
  - { id: embed, provider: openai, api-type: openai-embeddings }
  - { id: whisper, provider: openai, api-type: openai-audio }
routes:
  - { id: chat, name: Chat, models: [openai/gpt-chat] }
  - { id: resp, models: [openai/gpt-resp] }
  - { id: claude, models: [anthropic/claude] }
  - { id: combo, models: [anthropic/claude, openai/gpt-chat] }
  - { id: duo, models: [openai/gpt-chat, openai2/gpt-chat-b] }
  - { id: embed, models: [openai/embed] }
  - { id: whisper, models: [openai/whisper] }
`;

export interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

export type Upstream = (req: Request, call: Recorded) => Response | Promise<Response>;

/** fetch palsu: merekam request lalu memanggil `upstream`. */
export function mockFetch(upstream: Upstream) {
  const calls: Recorded[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.clone().text();
    const call = { url: req.url, method: req.method, headers: req.headers, body };
    calls.push(call);
    return upstream(req, call);
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

export function makeApp(upstream: Upstream, options: { config?: string; state?: RouterState } = {}) {
  const config = parseConfig(options.config ?? TEST_CONFIG, { env: {} });
  const mock = mockFetch(upstream);
  const state = options.state ?? createState();
  const app = createApp(config, { fetch: mock.fetch, logger: silentLogger, state });
  return { app, calls: mock.calls, state, config };
}

export function authed(init: RequestInit & { json?: unknown } = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (!headers.has('authorization') && !headers.has('x-api-key')) headers.set('authorization', `Bearer ${CLIENT_KEY}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  return { method: init.json !== undefined ? 'POST' : (init.method ?? 'GET'), ...init, headers, body };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** Respons SSE; tiap string di `pieces` dikirim sebagai chunk terpisah. */
export function sseResponse(pieces: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of pieces) controller.enqueue(encoder.encode(p));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export function sseEvents(events: { event?: string; data: unknown }[]): string[] {
  return events.map((e) => `${e.event ? `event: ${e.event}\n` : ''}data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`);
}

/** Parse body SSE respons router menjadi daftar {event, data}. */
export async function readSse(res: Response): Promise<{ event?: string; data: any }[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      let event: string | undefined;
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data.push(line.slice(6));
      }
      const raw = data.join('\n');
      let parsed: unknown = raw;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // [DONE]
      }
      return { event, data: parsed };
    });
}
