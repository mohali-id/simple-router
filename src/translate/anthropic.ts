/**
 * Anthropic Messages API <-> hub (OpenAI Chat Completions), non-stream.
 */
import type {
  HubFinishReason,
  HubMessage,
  HubPart,
  HubRequest,
  HubResponse,
  HubTool,
  HubToolCall,
  HubToolChoice,
} from './types.js';
import {
  asArray,
  asNumber,
  asString,
  compact,
  genId,
  isRecord,
  nowSeconds,
  parseDataUrl,
  parseJsonObject,
  textOf,
  toStopArray,
} from './util.js';

export const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;

// ---------------------------------------------------------------------------
// Request: Anthropic -> hub
// ---------------------------------------------------------------------------

function anthropicBlockToPart(block: Record<string, unknown>): HubPart | undefined {
  if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
  const source = isRecord(block.source) ? block.source : undefined;
  if (block.type === 'image' && source) {
    if (source.type === 'base64') {
      return { type: 'image_url', image_url: { url: `data:${String(source.media_type)};base64,${String(source.data)}` } };
    }
    if (source.type === 'url' && typeof source.url === 'string') return { type: 'image_url', image_url: { url: source.url } };
    if (source.type === 'file' && typeof source.file_id === 'string') return { type: 'file', file: { file_id: source.file_id } };
  }
  if (block.type === 'document' && source) {
    if (source.type === 'file' && typeof source.file_id === 'string') return { type: 'file', file: { file_id: source.file_id } };
    if (source.type === 'base64') {
      return {
        type: 'file',
        file: compact({ file_data: `data:${String(source.media_type)};base64,${String(source.data)}`, filename: asString(block.title) }),
      };
    }
    if (source.type === 'text' && typeof source.data === 'string') return { type: 'text', text: source.data };
  }
  return undefined;
}

function toolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  return textOf(content);
}

function anthropicToolChoice(choice: unknown): { choice?: HubToolChoice; parallel?: boolean } {
  if (!isRecord(choice)) return {};
  const parallel = choice.disable_parallel_tool_use === true ? false : undefined;
  switch (choice.type) {
    case 'auto':
      return { choice: 'auto', parallel };
    case 'any':
      return { choice: 'required', parallel };
    case 'none':
      return { choice: 'none' };
    case 'tool':
      return typeof choice.name === 'string'
        ? { choice: { type: 'function', function: { name: choice.name } }, parallel }
        : {};
    default:
      return {};
  }
}

function budgetToEffort(budget: number | undefined): HubRequest['reasoning_effort'] {
  if (budget === undefined) return undefined;
  if (budget <= 2048) return 'low';
  if (budget <= 8192) return 'medium';
  return 'high';
}

export function anthropicRequestToHub(body: Record<string, unknown>): HubRequest {
  const messages: HubMessage[] = [];

  const system = typeof body.system === 'string' ? body.system : textOf(body.system);
  if (system) messages.push({ role: 'system', content: system });

  for (const raw of asArray(body.messages)) {
    if (!isRecord(raw)) continue;
    const role = raw.role === 'assistant' ? 'assistant' : 'user';
    if (typeof raw.content === 'string') {
      messages.push({ role, content: raw.content });
      continue;
    }
    const blocks = asArray(raw.content).filter(isRecord);

    if (role === 'assistant') {
      let text = '';
      let reasoning = '';
      const toolCalls: HubToolCall[] = [];
      for (const b of blocks) {
        if (b.type === 'text' && typeof b.text === 'string') text += b.text;
        else if (b.type === 'thinking' && typeof b.thinking === 'string') reasoning += b.thinking;
        else if (b.type === 'tool_use') {
          toolCalls.push({
            id: asString(b.id) ?? genId('call_'),
            type: 'function',
            function: { name: asString(b.name) ?? '', arguments: JSON.stringify(b.input ?? {}) },
          });
        }
      }
      messages.push(
        compact({
          role: 'assistant' as const,
          content: text || null,
          tool_calls: toolCalls.length ? toolCalls : undefined,
          reasoning_content: reasoning || undefined,
        }),
      );
      continue;
    }

    // user: tool_result menjadi pesan `tool` terpisah (harus mendahului teks user berikutnya).
    const parts: HubPart[] = [];
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        const text = toolResultContent(b.content);
        messages.push({
          role: 'tool',
          tool_call_id: asString(b.tool_use_id) ?? '',
          content: b.is_error === true ? `[error] ${text}` : text,
        });
      } else {
        const part = anthropicBlockToPart(b);
        if (part) parts.push(part);
      }
    }
    if (parts.length) messages.push({ role: 'user', content: parts });
  }

  const tools: HubTool[] = asArray(body.tools)
    .filter(isRecord)
    .filter((t) => typeof t.name === 'string' && (t.type === undefined || t.type === 'custom'))
    .map((t) => ({
      type: 'function',
      function: compact({
        name: t.name as string,
        description: asString(t.description),
        parameters: t.input_schema ?? { type: 'object', properties: {} },
      }),
    }));

  const { choice, parallel } = anthropicToolChoice(body.tool_choice);
  const thinking = isRecord(body.thinking) && body.thinking.type === 'enabled' ? body.thinking : undefined;
  const metadata = isRecord(body.metadata) ? body.metadata : undefined;

  return compact({
    model: asString(body.model) ?? '',
    messages,
    tools: tools.length ? tools : undefined,
    tool_choice: choice,
    parallel_tool_calls: parallel,
    max_tokens: asNumber(body.max_tokens),
    temperature: asNumber(body.temperature),
    top_p: asNumber(body.top_p),
    stop: toStopArray(body.stop_sequences),
    stream: body.stream === true,
    user: asString(metadata?.user_id),
    reasoning_effort: budgetToEffort(asNumber(thinking?.budget_tokens)),
  });
}

// ---------------------------------------------------------------------------
// Request: hub -> Anthropic
// ---------------------------------------------------------------------------

type AnthropicBlock = Record<string, unknown>;

function partToAnthropicBlock(part: HubPart): AnthropicBlock | undefined {
  if (part.type === 'text') return { type: 'text', text: part.text };
  if (part.type === 'image_url') {
    const data = parseDataUrl(part.image_url.url);
    if (data) return { type: 'image', source: { type: 'base64', media_type: data.mediaType, data: data.data } };
    return { type: 'image', source: { type: 'url', url: part.image_url.url } };
  }
  if (part.file.file_id) return { type: 'document', source: { type: 'file', file_id: part.file.file_id } };
  if (part.file.file_data) {
    const data = parseDataUrl(part.file.file_data);
    if (data) {
      return compact({
        type: 'document',
        source: { type: 'base64', media_type: data.mediaType, data: data.data },
        title: part.file.filename,
      });
    }
  }
  return undefined;
}

function contentToBlocks(content: HubMessage['content']): AnthropicBlock[] {
  if (content === null) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return content.map(partToAnthropicBlock).filter((b): b is AnthropicBlock => b !== undefined);
}

function hubToolChoiceToAnthropic(choice: HubToolChoice | undefined, parallel: boolean | undefined): unknown {
  const disable = parallel === false ? { disable_parallel_tool_use: true } : {};
  if (choice === undefined) return parallel === false ? { type: 'auto', ...disable } : undefined;
  if (choice === 'auto') return { type: 'auto', ...disable };
  if (choice === 'required') return { type: 'any', ...disable };
  if (choice === 'none') return { type: 'none' };
  return { type: 'tool', name: choice.function.name, ...disable };
}

export function hubToAnthropicRequest(hub: HubRequest): Record<string, unknown> {
  const systemParts: string[] = [];
  const messages: { role: 'user' | 'assistant'; content: AnthropicBlock[] }[] = [];

  const push = (role: 'user' | 'assistant', blocks: AnthropicBlock[]) => {
    if (blocks.length === 0) return;
    const last = messages.at(-1);
    // Anthropic mensyaratkan role bergantian: gabungkan pesan berurutan dengan role sama.
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };

  for (const m of hub.messages) {
    switch (m.role) {
      case 'system':
      case 'developer': {
        const text = typeof m.content === 'string' ? m.content : textOf(m.content);
        if (text) systemParts.push(text);
        break;
      }
      case 'user':
        push('user', contentToBlocks(m.content));
        break;
      case 'assistant': {
        const blocks = contentToBlocks(m.content);
        for (const call of m.tool_calls ?? []) {
          blocks.push({
            type: 'tool_use',
            id: call.id,
            name: call.function.name,
            input: parseJsonObject(call.function.arguments),
          });
        }
        push('assistant', blocks);
        break;
      }
      case 'tool': {
        const text = typeof m.content === 'string' ? m.content : textOf(m.content);
        push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: text }]);
        break;
      }
    }
  }

  // tool_result harus berada di awal pesan user.
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    msg.content.sort((a, b) => Number(b.type === 'tool_result') - Number(a.type === 'tool_result'));
  }

  const tools = hub.tools?.map((t) =>
    compact({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }),
  );

  return compact({
    model: hub.model,
    system: systemParts.length ? systemParts.join('\n\n') : undefined,
    messages,
    max_tokens: hub.max_tokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
    temperature: hub.temperature,
    top_p: hub.top_p,
    stop_sequences: hub.stop,
    stream: hub.stream || undefined,
    tools: tools?.length ? tools : undefined,
    tool_choice: tools?.length ? hubToolChoiceToAnthropic(hub.tool_choice, hub.parallel_tool_calls) : undefined,
    metadata: hub.user ? { user_id: hub.user } : undefined,
  });
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export function anthropicStopToFinish(reason: unknown): HubFinishReason {
  switch (reason) {
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return 'stop';
  }
}

export function finishToAnthropicStop(reason: HubFinishReason | null | undefined): string {
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

export function anthropicUsageToHub(usage: unknown): HubResponse['usage'] {
  if (!isRecord(usage)) return undefined;
  const prompt =
    (asNumber(usage.input_tokens) ?? 0) +
    (asNumber(usage.cache_read_input_tokens) ?? 0) +
    (asNumber(usage.cache_creation_input_tokens) ?? 0);
  const completion = asNumber(usage.output_tokens) ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

export function anthropicResponseToHub(body: Record<string, unknown>): HubResponse {
  let text = '';
  let reasoning = '';
  const toolCalls: HubToolCall[] = [];
  for (const b of asArray(body.content).filter(isRecord)) {
    if (b.type === 'text' && typeof b.text === 'string') text += b.text;
    else if (b.type === 'thinking' && typeof b.thinking === 'string') reasoning += b.thinking;
    else if (b.type === 'tool_use') {
      toolCalls.push({
        id: asString(b.id) ?? genId('call_'),
        type: 'function',
        function: { name: asString(b.name) ?? '', arguments: JSON.stringify(b.input ?? {}) },
      });
    }
  }
  return compact({
    id: asString(body.id) ?? genId('chatcmpl-'),
    object: 'chat.completion' as const,
    created: nowSeconds(),
    model: asString(body.model) ?? '',
    choices: [
      {
        index: 0,
        message: compact({
          role: 'assistant' as const,
          content: text || (toolCalls.length ? null : ''),
          tool_calls: toolCalls.length ? toolCalls : undefined,
          reasoning_content: reasoning || undefined,
        }),
        finish_reason: anthropicStopToFinish(body.stop_reason),
      },
    ],
    usage: anthropicUsageToHub(body.usage),
  });
}

export function hubToAnthropicResponse(hub: HubResponse): Record<string, unknown> {
  const choice = hub.choices[0];
  const content: AnthropicBlock[] = [];
  if (choice?.message.reasoning_content) {
    content.push({ type: 'thinking', thinking: choice.message.reasoning_content, signature: '' });
  }
  if (choice?.message.content) content.push({ type: 'text', text: choice.message.content });
  for (const call of choice?.message.tool_calls ?? []) {
    content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: parseJsonObject(call.function.arguments) });
  }
  return {
    id: hub.id.startsWith('msg_') ? hub.id : `msg_${hub.id.replace(/^[a-z]+[-_]/i, '')}`,
    type: 'message',
    role: 'assistant',
    model: hub.model,
    content,
    stop_reason: finishToAnthropicStop(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: hub.usage?.prompt_tokens ?? 0,
      output_tokens: hub.usage?.completion_tokens ?? 0,
    },
  };
}
