/**
 * Stream OpenAI Responses <-> chunk hub.
 */
import { extractErrorMessage } from '../../errors.js';
import { formatSse, type SseEvent } from '../../sse.js';
import { buildResponsesObject, responsesStatusToFinish, responsesUsageToHub } from '../responses.js';
import type { HubChunk, HubFinishReason, HubUsage } from '../types.js';
import { asNumber, asString, genId, isRecord, nowSeconds } from '../util.js';
import { type StreamEmitter, UpstreamStreamError } from './types.js';

// ---------------------------------------------------------------------------
// Upstream Responses -> hub
// ---------------------------------------------------------------------------

export async function* responsesStreamToHub(events: AsyncIterable<SseEvent>): AsyncGenerator<HubChunk> {
  let id = genId('chatcmpl-');
  let model = '';
  let created = nowSeconds();
  let toolCount = -1;
  const toolIndexByItem = new Map<string, number>();

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
    const type = asString(data.type) ?? ev.event;

    switch (type) {
      case 'response.created': {
        const response = isRecord(data.response) ? data.response : {};
        id = asString(response.id) ?? id;
        model = asString(response.model) ?? model;
        created = asNumber(response.created_at) ?? created;
        yield chunk({ role: 'assistant', content: '' });
        break;
      }
      case 'response.output_item.added': {
        const item = isRecord(data.item) ? data.item : {};
        if (item.type === 'function_call') {
          toolCount += 1;
          const key = asString(item.id) ?? String(data.output_index);
          toolIndexByItem.set(key, toolCount);
          yield chunk({
            tool_calls: [
              {
                index: toolCount,
                id: asString(item.call_id) ?? genId('call_'),
                type: 'function',
                function: { name: asString(item.name) ?? '', arguments: asString(item.arguments) ?? '' },
              },
            ],
          });
        }
        break;
      }
      case 'response.function_call_arguments.delta': {
        const key = asString(data.item_id) ?? String(data.output_index);
        const index = toolIndexByItem.get(key);
        if (index !== undefined && typeof data.delta === 'string' && data.delta) {
          yield chunk({ tool_calls: [{ index, function: { arguments: data.delta } }] });
        }
        break;
      }
      case 'response.output_text.delta':
      case 'response.refusal.delta':
        if (typeof data.delta === 'string' && data.delta) yield chunk({ content: data.delta });
        break;
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (typeof data.delta === 'string' && data.delta) yield chunk({ reasoning_content: data.delta });
        break;
      case 'response.completed':
      case 'response.incomplete': {
        const response = isRecord(data.response) ? data.response : {};
        yield chunk({}, responsesStatusToFinish(response, toolCount >= 0), responsesUsageToHub(response.usage));
        return;
      }
      case 'response.failed': {
        const response = isRecord(data.response) ? data.response : {};
        throw new UpstreamStreamError(extractErrorMessage(response, 'upstream response failed'));
      }
      case 'error':
        throw new UpstreamStreamError(asString(data.message) ?? extractErrorMessage(data, 'upstream stream error'));
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// hub -> client Responses
// ---------------------------------------------------------------------------

interface OpenItem {
  kind: 'message' | 'reasoning' | 'function_call';
  id: string;
  outputIndex: number;
  text: string;
  toolIndex?: number;
  callId?: string;
  name?: string;
}

export function createResponsesEmitter(): StreamEmitter {
  const id = genId('resp_');
  const createdAt = nowSeconds();
  let model = '';
  let seq = 0;
  let started = false;
  let current: OpenItem | undefined;
  const output: Record<string, unknown>[] = [];
  let finish: HubFinishReason | null = null;
  let usage: HubUsage | undefined;

  const ev = (type: string, payload: Record<string, unknown>) => formatSse({ type, sequence_number: seq++, ...payload }, type);

  const snapshot = (status: string) => ({
    ...buildResponsesObject({ id, model, createdAt, output, finish, usage }),
    status,
  });

  const start = (out: string[]) => {
    if (started) return;
    started = true;
    out.push(ev('response.created', { response: { ...snapshot('in_progress'), output: [], usage: null } }));
    out.push(ev('response.in_progress', { response: { ...snapshot('in_progress'), output: [], usage: null } }));
  };

  const closeItem = (out: string[]) => {
    const item = current;
    if (!item) return;
    current = undefined;
    const base = { item_id: item.id, output_index: item.outputIndex };
    let done: Record<string, unknown>;
    if (item.kind === 'message') {
      const part = { type: 'output_text', text: item.text, annotations: [] };
      out.push(ev('response.output_text.done', { ...base, content_index: 0, text: item.text }));
      out.push(ev('response.content_part.done', { ...base, content_index: 0, part }));
      done = { type: 'message', id: item.id, status: 'completed', role: 'assistant', content: [part] };
    } else if (item.kind === 'reasoning') {
      const part = { type: 'summary_text', text: item.text };
      out.push(ev('response.reasoning_summary_text.done', { ...base, summary_index: 0, text: item.text }));
      out.push(ev('response.reasoning_summary_part.done', { ...base, summary_index: 0, part }));
      done = { type: 'reasoning', id: item.id, summary: [part] };
    } else {
      out.push(ev('response.function_call_arguments.done', { ...base, arguments: item.text }));
      done = {
        type: 'function_call',
        id: item.id,
        call_id: item.callId,
        name: item.name,
        arguments: item.text,
        status: 'completed',
      };
    }
    output.push(done);
    out.push(ev('response.output_item.done', { output_index: item.outputIndex, item: done }));
  };

  const openItem = (out: string[], item: Omit<OpenItem, 'outputIndex' | 'text'>) => {
    closeItem(out);
    current = { ...item, outputIndex: output.length, text: '' };
    const base = { item_id: item.id, output_index: current.outputIndex };
    if (item.kind === 'message') {
      out.push(ev('response.output_item.added', {
        output_index: current.outputIndex,
        item: { type: 'message', id: item.id, status: 'in_progress', role: 'assistant', content: [] },
      }));
      out.push(ev('response.content_part.added', { ...base, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }));
    } else if (item.kind === 'reasoning') {
      out.push(ev('response.output_item.added', { output_index: current.outputIndex, item: { type: 'reasoning', id: item.id, summary: [] } }));
      out.push(ev('response.reasoning_summary_part.added', { ...base, summary_index: 0, part: { type: 'summary_text', text: '' } }));
    } else {
      out.push(ev('response.output_item.added', {
        output_index: current.outputIndex,
        item: { type: 'function_call', id: item.id, call_id: item.callId, name: item.name, arguments: '', status: 'in_progress' },
      }));
    }
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
        if (current?.kind !== 'reasoning') openItem(out, { kind: 'reasoning', id: genId('rs_') });
        current!.text += delta.reasoning_content;
        out.push(ev('response.reasoning_summary_text.delta', {
          item_id: current!.id, output_index: current!.outputIndex, summary_index: 0, delta: delta.reasoning_content,
        }));
      }
      if (delta.content) {
        if (current?.kind !== 'message') openItem(out, { kind: 'message', id: genId('msg_') });
        current!.text += delta.content;
        out.push(ev('response.output_text.delta', {
          item_id: current!.id, output_index: current!.outputIndex, content_index: 0, delta: delta.content, logprobs: [],
        }));
      }
      for (const tc of delta.tool_calls ?? []) {
        const isNew = tc.id !== undefined || current?.kind !== 'function_call' || current.toolIndex !== tc.index;
        if (isNew) {
          openItem(out, {
            kind: 'function_call',
            id: genId('fc_'),
            toolIndex: tc.index,
            callId: tc.id ?? genId('call_'),
            name: tc.function?.name ?? '',
          });
        }
        const args = tc.function?.arguments;
        if (args) {
          current!.text += args;
          out.push(ev('response.function_call_arguments.delta', { item_id: current!.id, output_index: current!.outputIndex, delta: args }));
        }
      }
      if (choice.finish_reason) finish = choice.finish_reason;
      return out;
    },
    end() {
      const out: string[] = [];
      start(out);
      closeItem(out);
      const final = buildResponsesObject({ id, model, createdAt, output, finish, usage });
      out.push(ev(final.status === 'incomplete' ? 'response.incomplete' : 'response.completed', { response: final }));
      return out;
    },
    error(message) {
      return [ev('error', { code: 'upstream_error', message, param: null })];
    },
  };
}
