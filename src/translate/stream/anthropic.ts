/**
 * Stream Anthropic Messages <-> chunk hub.
 */
import { extractErrorMessage } from '../../errors.js';
import { formatSse, type SseEvent } from '../../sse.js';
import { anthropicStopToFinish, finishToAnthropicStop } from '../anthropic.js';
import type { HubChunk, HubFinishReason, HubUsage } from '../types.js';
import { asNumber, asString, genId, isRecord, nowSeconds } from '../util.js';
import { type StreamEmitter, UpstreamStreamError } from './types.js';

// ---------------------------------------------------------------------------
// Upstream Anthropic -> hub
// ---------------------------------------------------------------------------

export async function* anthropicStreamToHub(events: AsyncIterable<SseEvent>): AsyncGenerator<HubChunk> {
  let id = genId('chatcmpl-');
  let model = '';
  const created = nowSeconds();
  let promptTokens = 0;
  let toolCount = -1;
  const toolIndexByBlock = new Map<number, number>();

  const chunk = (delta: HubChunk['choices'][number]['delta'], finish: HubFinishReason | null = null, usage?: HubUsage): HubChunk => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  });

  for await (const ev of events) {
    let data: unknown;
    try {
      data = JSON.parse(ev.data);
    } catch {
      continue;
    }
    if (!isRecord(data)) continue;

    switch (data.type) {
      case 'message_start': {
        const message = isRecord(data.message) ? data.message : {};
        id = asString(message.id) ?? id;
        model = asString(message.model) ?? model;
        const usage = isRecord(message.usage) ? message.usage : {};
        promptTokens =
          (asNumber(usage.input_tokens) ?? 0) +
          (asNumber(usage.cache_read_input_tokens) ?? 0) +
          (asNumber(usage.cache_creation_input_tokens) ?? 0);
        yield chunk({ role: 'assistant', content: '' });
        break;
      }
      case 'content_block_start': {
        const block = isRecord(data.content_block) ? data.content_block : {};
        const index = asNumber(data.index) ?? 0;
        if (block.type === 'tool_use') {
          toolCount += 1;
          toolIndexByBlock.set(index, toolCount);
          yield chunk({
            tool_calls: [
              {
                index: toolCount,
                id: asString(block.id) ?? genId('call_'),
                type: 'function',
                function: { name: asString(block.name) ?? '', arguments: '' },
              },
            ],
          });
        } else if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          yield chunk({ content: block.text });
        }
        break;
      }
      case 'content_block_delta': {
        const delta = isRecord(data.delta) ? data.delta : {};
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          yield chunk({ content: delta.text });
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          yield chunk({ reasoning_content: delta.thinking });
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const toolIndex = toolIndexByBlock.get(asNumber(data.index) ?? -1);
          if (toolIndex !== undefined && delta.partial_json) {
            yield chunk({ tool_calls: [{ index: toolIndex, function: { arguments: delta.partial_json } }] });
          }
        }
        break;
      }
      case 'message_delta': {
        const delta = isRecord(data.delta) ? data.delta : {};
        const usage = isRecord(data.usage) ? data.usage : {};
        const completion = asNumber(usage.output_tokens) ?? 0;
        const input = asNumber(usage.input_tokens);
        if (input !== undefined && promptTokens === 0) promptTokens = input;
        yield chunk({}, anthropicStopToFinish(delta.stop_reason), {
          prompt_tokens: promptTokens,
          completion_tokens: completion,
          total_tokens: promptTokens + completion,
        });
        break;
      }
      case 'message_stop':
        return;
      case 'error':
        throw new UpstreamStreamError(extractErrorMessage(data, 'upstream stream error'));
      default:
        break; // ping, signature_delta, dll.
    }
  }
}

// ---------------------------------------------------------------------------
// hub -> client Anthropic
// ---------------------------------------------------------------------------

export function createAnthropicEmitter(): StreamEmitter {
  const id = genId('msg_');
  let model = '';
  let started = false;
  let blockIndex = -1;
  let current: { kind: 'text' | 'thinking' | 'tool'; toolIndex?: number } | undefined;
  let finish: HubFinishReason | null = null;
  let usage: HubUsage | undefined;

  const ev = (type: string, payload: Record<string, unknown>) => formatSse({ type, ...payload }, type);

  const start = (out: string[]) => {
    if (started) return;
    started = true;
    out.push(
      ev('message_start', {
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: usage?.prompt_tokens ?? 0, output_tokens: 0 },
        },
      }),
    );
  };

  const closeBlock = (out: string[]) => {
    if (!current) return;
    out.push(ev('content_block_stop', { index: blockIndex }));
    current = undefined;
  };

  const openBlock = (out: string[], kind: 'text' | 'thinking' | 'tool', contentBlock: Record<string, unknown>, toolIndex?: number) => {
    closeBlock(out);
    blockIndex += 1;
    current = { kind, toolIndex };
    out.push(ev('content_block_start', { index: blockIndex, content_block: contentBlock }));
  };

  return {
    push(chunk) {
      const out: string[] = [];
      if (chunk.model) model ||= chunk.model;
      if (chunk.usage) usage = chunk.usage;
      start(out);
      const choice = chunk.choices[0];
      if (!choice) return out;
      const delta = choice.delta;

      if (delta.reasoning_content) {
        if (current?.kind !== 'thinking') openBlock(out, 'thinking', { type: 'thinking', thinking: '' });
        out.push(ev('content_block_delta', { index: blockIndex, delta: { type: 'thinking_delta', thinking: delta.reasoning_content } }));
      }
      if (delta.content) {
        if (current?.kind !== 'text') openBlock(out, 'text', { type: 'text', text: '' });
        out.push(ev('content_block_delta', { index: blockIndex, delta: { type: 'text_delta', text: delta.content } }));
      }
      for (const tc of delta.tool_calls ?? []) {
        const isNew = tc.id !== undefined || current?.kind !== 'tool' || current.toolIndex !== tc.index;
        if (isNew) {
          openBlock(
            out,
            'tool',
            { type: 'tool_use', id: tc.id ?? genId('toolu_'), name: tc.function?.name ?? '', input: {} },
            tc.index,
          );
        }
        if (tc.function?.arguments) {
          out.push(ev('content_block_delta', { index: blockIndex, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } }));
        }
      }
      if (choice.finish_reason) finish = choice.finish_reason;
      return out;
    },
    end() {
      const out: string[] = [];
      start(out);
      closeBlock(out);
      out.push(
        ev('message_delta', {
          delta: { stop_reason: finishToAnthropicStop(finish), stop_sequence: null },
          usage: { input_tokens: usage?.prompt_tokens ?? 0, output_tokens: usage?.completion_tokens ?? 0 },
        }),
      );
      out.push(ev('message_stop', {}));
      return out;
    },
    error(message) {
      return [ev('error', { error: { type: 'api_error', message } })];
    },
  };
}
