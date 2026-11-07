/**
 * Pilih translator berdasar (format inbound, api-type upstream).
 * Hub = OpenAI Chat Completions.
 */
import { parseSse } from '../sse.js';
import { anthropicRequestToHub, anthropicResponseToHub, hubToAnthropicRequest, hubToAnthropicResponse } from './anthropic.js';
import { chatRequestToHub, chatResponseToHub, hubToChatRequest, hubToChatResponse } from './chat.js';
import { hubToResponsesRequest, hubToResponsesResponse, responsesRequestToHub, responsesResponseToHub } from './responses.js';
import { anthropicStreamToHub, createAnthropicEmitter } from './stream/anthropic.js';
import { chatStreamToHub, createChatEmitter } from './stream/chat.js';
import { createResponsesEmitter, responsesStreamToHub } from './stream/responses.js';
import type { StreamEmitter } from './stream/types.js';
import type { HubChunk, HubRequest, HubResponse } from './types.js';

export { TranslationError } from './types.js';

export type ChatFormat = 'openai-completions' | 'openai-responses' | 'anthropic-messages';

export function isChatFormat(value: string): value is ChatFormat {
  return value === 'openai-completions' || value === 'openai-responses' || value === 'anthropic-messages';
}

const toHubRequest: Record<ChatFormat, (body: Record<string, unknown>) => HubRequest> = {
  'openai-completions': chatRequestToHub,
  'openai-responses': responsesRequestToHub,
  'anthropic-messages': anthropicRequestToHub,
};

const fromHubRequest: Record<ChatFormat, (hub: HubRequest) => Record<string, unknown>> = {
  'openai-completions': hubToChatRequest,
  'openai-responses': hubToResponsesRequest,
  'anthropic-messages': hubToAnthropicRequest,
};

const toHubResponse: Record<ChatFormat, (body: Record<string, unknown>) => HubResponse> = {
  'openai-completions': chatResponseToHub,
  'openai-responses': responsesResponseToHub,
  'anthropic-messages': anthropicResponseToHub,
};

const fromHubResponse: Record<ChatFormat, (hub: HubResponse) => Record<string, unknown>> = {
  'openai-completions': hubToChatResponse,
  'openai-responses': hubToResponsesResponse,
  'anthropic-messages': hubToAnthropicResponse,
};

/** Body request untuk upstream. Format sama → hanya ganti `model`. */
export function translateRequest(
  from: ChatFormat,
  to: ChatFormat,
  body: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  if (from === to) return { ...body, model: upstreamModel };
  const hub = toHubRequest[from](body);
  hub.model = upstreamModel;
  return fromHubRequest[to](hub);
}

/** Body respons non-stream untuk client. */
export function translateResponse(from: ChatFormat, to: ChatFormat, body: Record<string, unknown>): Record<string, unknown> {
  if (from === to) return body;
  return fromHubResponse[to](toHubResponse[from](body));
}

function upstreamChunks(from: ChatFormat, body: ReadableStream<Uint8Array>): AsyncGenerator<HubChunk> {
  const events = parseSse(body);
  if (from === 'anthropic-messages') return anthropicStreamToHub(events);
  if (from === 'openai-responses') return responsesStreamToHub(events);
  return chatStreamToHub(events);
}

function emitterFor(to: ChatFormat, includeUsage: boolean): StreamEmitter {
  if (to === 'anthropic-messages') return createAnthropicEmitter();
  if (to === 'openai-responses') return createResponsesEmitter();
  return createChatEmitter({ includeUsage });
}

export interface StreamOptions {
  /** Untuk client Chat Completions: kirim usage hanya bila diminta (`stream_options.include_usage`). */
  includeUsage?: boolean;
  onError?: (err: unknown) => void;
}

/**
 * Stream SSE untuk client. Format sama → body upstream diteruskan apa adanya.
 * Berbeda → upstream SSE → chunk hub → SSE format inbound, chunk-per-chunk.
 */
export function translateStream(
  from: ChatFormat,
  to: ChatFormat,
  body: ReadableStream<Uint8Array>,
  options: StreamOptions = {},
): ReadableStream<Uint8Array> {
  if (from === to) return body;
  const chunks = upstreamChunks(from, body);
  const emitter = emitterFor(to, options.includeUsage ?? false);
  const encoder = new TextEncoder();
  let closed = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Ulangi sampai ada output: pull yang tidak meng-enqueue apa pun bisa membuat stream macet.
      for (;;) {
        let pieces: string[];
        let finished = false;
        try {
          const next = await chunks.next();
          if (next.done) {
            pieces = emitter.end();
            finished = true;
          } else {
            pieces = emitter.push(next.value);
          }
        } catch (err) {
          options.onError?.(err);
          pieces = emitter.error(err instanceof Error ? err.message : String(err));
          finished = true;
        }
        if (pieces.length) controller.enqueue(encoder.encode(pieces.join('')));
        if (finished) {
          closed = true;
          controller.close();
          return;
        }
        if (pieces.length) return;
      }
    },
    async cancel() {
      if (!closed) await chunks.return(undefined);
    },
  });
}
