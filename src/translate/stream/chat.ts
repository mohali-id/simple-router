/**
 * Stream OpenAI Chat Completions <-> chunk hub (formatnya sama).
 */
import { formatSse, type SseEvent } from '../../sse.js';
import type { HubChunk } from '../types.js';
import { extractErrorMessage } from '../../errors.js';
import { genId, isRecord, nowSeconds } from '../util.js';
import { type StreamEmitter, UpstreamStreamError } from './types.js';

export async function* chatStreamToHub(events: AsyncIterable<SseEvent>): AsyncGenerator<HubChunk> {
  for await (const ev of events) {
    if (ev.data === '[DONE]') return;
    let json: unknown;
    try {
      json = JSON.parse(ev.data);
    } catch {
      continue;
    }
    if (!isRecord(json)) continue;
    if (json.error) throw new UpstreamStreamError(extractErrorMessage(json, 'upstream stream error'));
    if (!Array.isArray(json.choices)) json.choices = [];
    yield json as unknown as HubChunk;
  }
}

export function createChatEmitter(options: { includeUsage: boolean }): StreamEmitter {
  const id = genId('chatcmpl-');
  const created = nowSeconds();
  return {
    push(chunk) {
      const out: HubChunk = { ...chunk, id, created, object: 'chat.completion.chunk' };
      if (!options.includeUsage) delete out.usage;
      if (out.choices.length === 0 && !out.usage) return [];
      return [formatSse(out)];
    },
    end() {
      return [formatSse('[DONE]')];
    },
    error(message) {
      return [formatSse({ error: { message, type: 'server_error', param: null, code: 'upstream_error' } }), formatSse('[DONE]')];
    },
  };
}
