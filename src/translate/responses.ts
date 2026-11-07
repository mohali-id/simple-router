/**
 * OpenAI Responses API <-> hub (OpenAI Chat Completions), non-stream.
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
import { TranslationError } from './types.js';
import { asArray, asNumber, asString, compact, genId, isRecord, nowSeconds, toOpenAIUser } from './util.js';

// ---------------------------------------------------------------------------
// Request: Responses -> hub
// ---------------------------------------------------------------------------

function responsesPartToHub(part: Record<string, unknown>): HubPart | undefined {
  switch (part.type) {
    case 'input_text':
    case 'output_text':
    case 'text':
      return typeof part.text === 'string' ? { type: 'text', text: part.text } : undefined;
    case 'refusal':
      return typeof part.refusal === 'string' ? { type: 'text', text: part.refusal } : undefined;
    case 'input_image': {
      if (typeof part.image_url === 'string') {
        return { type: 'image_url', image_url: compact({ url: part.image_url, detail: asString(part.detail) }) };
      }
      if (typeof part.file_id === 'string') return { type: 'file', file: { file_id: part.file_id } };
      return undefined;
    }
    case 'input_file':
      return {
        type: 'file',
        file: compact({
          file_id: asString(part.file_id),
          file_data: asString(part.file_data),
          filename: asString(part.filename),
        }),
      };
    default:
      return undefined;
  }
}

function responsesContentToHub(content: unknown): string | HubPart[] {
  if (typeof content === 'string') return content;
  return asArray(content)
    .filter(isRecord)
    .map(responsesPartToHub)
    .filter((p): p is HubPart => p !== undefined);
}

function responsesToolChoice(choice: unknown): HubToolChoice | undefined {
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  if (isRecord(choice) && choice.type === 'function' && typeof choice.name === 'string') {
    return { type: 'function', function: { name: choice.name } };
  }
  return undefined;
}

export function responsesRequestToHub(body: Record<string, unknown>): HubRequest {
  if (typeof body.previous_response_id === 'string') {
    throw new TranslationError('previous_response_id hanya didukung bila upstream juga OpenAI Responses');
  }

  const messages: HubMessage[] = [];
  if (typeof body.instructions === 'string' && body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
  }

  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
  } else {
    for (const item of asArray(body.input).filter(isRecord)) {
      const type = item.type ?? 'message';
      if (type === 'message') {
        const role = asString(item.role) ?? 'user';
        const content = responsesContentToHub(item.content);
        if (role === 'assistant') {
          const text = typeof content === 'string' ? content : content.map((p) => (p.type === 'text' ? p.text : '')).join('');
          messages.push({ role: 'assistant', content: text });
        } else {
          messages.push({ role: role === 'developer' || role === 'system' ? 'system' : 'user', content });
        }
      } else if (type === 'function_call') {
        const call: HubToolCall = {
          id: asString(item.call_id) ?? genId('call_'),
          type: 'function',
          function: { name: asString(item.name) ?? '', arguments: asString(item.arguments) ?? '{}' },
        };
        const last = messages.at(-1);
        // Beberapa function_call berurutan = satu pesan assistant dengan banyak tool_calls.
        if (last?.role === 'assistant' && !last.tool_calls?.length && !last.content) last.tool_calls = [call];
        else if (last?.role === 'assistant' && last.tool_calls?.length) last.tool_calls.push(call);
        else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
      } else if (type === 'function_call_output') {
        const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
        messages.push({ role: 'tool', tool_call_id: asString(item.call_id) ?? '', content: output });
      }
      // reasoning, item_reference, dll. dilewati.
    }
  }

  const tools: HubTool[] = [];
  for (const t of asArray(body.tools).filter(isRecord)) {
    if (t.type === 'function' && typeof t.name === 'string') {
      tools.push({
        type: 'function',
        function: compact({
          name: t.name,
          description: asString(t.description),
          parameters: t.parameters,
          strict: typeof t.strict === 'boolean' ? t.strict : undefined,
        }),
      });
    } else {
      // Tool bawaan (web_search, file_search, ...) tidak punya padanan di format lain.
      throw new TranslationError(`tool "${String(t.type)}" hanya didukung bila upstream OpenAI Responses`);
    }
  }

  const reasoning = isRecord(body.reasoning) ? body.reasoning : undefined;
  const format = isRecord(body.text) && isRecord(body.text.format) ? body.text.format : undefined;
  let responseFormat: HubRequest['response_format'];
  if (format?.type === 'json_schema' && typeof format.name === 'string') {
    responseFormat = {
      type: 'json_schema',
      json_schema: compact({
        name: format.name,
        schema: format.schema,
        strict: typeof format.strict === 'boolean' ? format.strict : undefined,
        description: asString(format.description),
      }),
    };
  } else if (format?.type === 'json_object') {
    responseFormat = { type: 'json_object' };
  }

  return compact({
    model: asString(body.model) ?? '',
    messages,
    tools: tools.length ? tools : undefined,
    tool_choice: responsesToolChoice(body.tool_choice),
    parallel_tool_calls: typeof body.parallel_tool_calls === 'boolean' ? body.parallel_tool_calls : undefined,
    max_tokens: asNumber(body.max_output_tokens),
    temperature: asNumber(body.temperature),
    top_p: asNumber(body.top_p),
    stream: body.stream === true,
    user: asString(body.user) ?? asString(body.safety_identifier),
    reasoning_effort: asString(reasoning?.effort) as HubRequest['reasoning_effort'],
    response_format: responseFormat,
  });
}

// ---------------------------------------------------------------------------
// Request: hub -> Responses
// ---------------------------------------------------------------------------

function hubPartToResponses(part: HubPart, role: 'user' | 'assistant'): Record<string, unknown> {
  if (part.type === 'text') return { type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text };
  if (part.type === 'image_url') return compact({ type: 'input_image', image_url: part.image_url.url, detail: part.image_url.detail ?? 'auto' });
  return compact({ type: 'input_file', file_id: part.file.file_id, file_data: part.file.file_data, filename: part.file.filename });
}

export function hubToResponsesRequest(hub: HubRequest): Record<string, unknown> {
  const instructions: string[] = [];
  const input: Record<string, unknown>[] = [];

  for (const m of hub.messages) {
    switch (m.role) {
      case 'system':
      case 'developer': {
        const text = typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n');
        if (text) instructions.push(text);
        break;
      }
      case 'user': {
        const content =
          typeof m.content === 'string'
            ? [{ type: 'input_text', text: m.content }]
            : (m.content ?? []).map((p) => hubPartToResponses(p, 'user'));
        input.push({ type: 'message', role: 'user', content });
        break;
      }
      case 'assistant': {
        const text = typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('');
        if (text) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
        for (const call of m.tool_calls ?? []) {
          input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
        }
        break;
      }
      case 'tool': {
        const output = typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('');
        input.push({ type: 'function_call_output', call_id: m.tool_call_id ?? '', output });
        break;
      }
    }
  }

  let toolChoice: unknown;
  if (typeof hub.tool_choice === 'string') toolChoice = hub.tool_choice;
  else if (hub.tool_choice) toolChoice = { type: 'function', name: hub.tool_choice.function.name };

  let text: unknown;
  if (hub.response_format?.type === 'json_schema') {
    text = { format: compact({ type: 'json_schema', ...hub.response_format.json_schema }) };
  } else if (hub.response_format?.type === 'json_object') {
    text = { format: { type: 'json_object' } };
  }

  return compact({
    model: hub.model,
    instructions: instructions.length ? instructions.join('\n\n') : undefined,
    input,
    tools: hub.tools?.map((t) =>
      compact({
        type: 'function',
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters ?? { type: 'object', properties: {} },
        strict: t.function.strict ?? false,
      }),
    ),
    tool_choice: toolChoice,
    parallel_tool_calls: hub.parallel_tool_calls,
    max_output_tokens: hub.max_tokens,
    temperature: hub.temperature,
    top_p: hub.top_p,
    stream: hub.stream || undefined,
    user: toOpenAIUser(hub.user),
    reasoning: hub.reasoning_effort ? { effort: hub.reasoning_effort } : undefined,
    text,
    store: false,
  });
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export function responsesUsageToHub(usage: unknown): HubResponse['usage'] {
  if (!isRecord(usage)) return undefined;
  const prompt = asNumber(usage.input_tokens) ?? 0;
  const completion = asNumber(usage.output_tokens) ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: asNumber(usage.total_tokens) ?? prompt + completion };
}

export function responsesStatusToFinish(body: Record<string, unknown>, hasToolCalls: boolean): HubFinishReason {
  if (body.status === 'incomplete') {
    const reason = isRecord(body.incomplete_details) ? body.incomplete_details.reason : undefined;
    return reason === 'content_filter' ? 'content_filter' : 'length';
  }
  return hasToolCalls ? 'tool_calls' : 'stop';
}

export function responsesResponseToHub(body: Record<string, unknown>): HubResponse {
  let text = '';
  let reasoning = '';
  let refusal = '';
  const toolCalls: HubToolCall[] = [];
  for (const item of asArray(body.output).filter(isRecord)) {
    if (item.type === 'message') {
      for (const part of asArray(item.content).filter(isRecord)) {
        if (part.type === 'output_text' && typeof part.text === 'string') text += part.text;
        else if (part.type === 'refusal' && typeof part.refusal === 'string') refusal += part.refusal;
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: asString(item.call_id) ?? genId('call_'),
        type: 'function',
        function: { name: asString(item.name) ?? '', arguments: asString(item.arguments) ?? '{}' },
      });
    } else if (item.type === 'reasoning') {
      for (const s of asArray(item.summary).filter(isRecord)) {
        if (typeof s.text === 'string') reasoning += s.text;
      }
    }
  }
  const finish = refusal && !text ? 'content_filter' : responsesStatusToFinish(body, toolCalls.length > 0);
  return compact({
    id: asString(body.id) ?? genId('chatcmpl-'),
    object: 'chat.completion' as const,
    created: asNumber(body.created_at) ?? nowSeconds(),
    model: asString(body.model) ?? '',
    choices: [
      {
        index: 0,
        message: compact({
          role: 'assistant' as const,
          content: text || refusal || (toolCalls.length ? null : ''),
          tool_calls: toolCalls.length ? toolCalls : undefined,
          reasoning_content: reasoning || undefined,
        }),
        finish_reason: finish,
      },
    ],
    usage: responsesUsageToHub(body.usage),
  });
}

/** Bangun objek Response dari bagian-bagiannya (dipakai juga oleh emitter stream). */
export function buildResponsesObject(args: {
  id: string;
  model: string;
  createdAt: number;
  output: Record<string, unknown>[];
  finish: HubFinishReason | null | undefined;
  usage?: HubResponse['usage'];
}): Record<string, unknown> {
  const incomplete = args.finish === 'length' || args.finish === 'content_filter';
  const outputText = args.output
    .filter((o) => o.type === 'message')
    .flatMap((o) => asArray(o.content))
    .map((p) => (isRecord(p) && typeof p.text === 'string' ? p.text : ''))
    .join('');
  return {
    id: args.id,
    object: 'response',
    created_at: args.createdAt,
    status: incomplete ? 'incomplete' : 'completed',
    incomplete_details: incomplete
      ? { reason: args.finish === 'length' ? 'max_output_tokens' : 'content_filter' }
      : null,
    model: args.model,
    output: args.output,
    output_text: outputText,
    usage: args.usage
      ? {
          input_tokens: args.usage.prompt_tokens,
          output_tokens: args.usage.completion_tokens,
          total_tokens: args.usage.total_tokens,
        }
      : null,
  };
}

export function hubToResponsesResponse(hub: HubResponse): Record<string, unknown> {
  const choice = hub.choices[0];
  const output: Record<string, unknown>[] = [];
  if (choice?.message.reasoning_content) {
    output.push({
      type: 'reasoning',
      id: genId('rs_'),
      summary: [{ type: 'summary_text', text: choice.message.reasoning_content }],
    });
  }
  if (choice?.message.content) {
    output.push({
      type: 'message',
      id: genId('msg_'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: choice.message.content, annotations: [] }],
    });
  }
  for (const call of choice?.message.tool_calls ?? []) {
    output.push({
      type: 'function_call',
      id: genId('fc_'),
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      status: 'completed',
    });
  }
  return buildResponsesObject({
    id: hub.id.startsWith('resp_') ? hub.id : genId('resp_'),
    model: hub.model,
    createdAt: hub.created,
    output,
    finish: choice?.finish_reason,
    usage: hub.usage,
  });
}
