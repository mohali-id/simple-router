/**
 * OpenAI Chat Completions <-> hub. Hub = Chat Completions, jadi ini hampir
 * identitas; tugasnya menormalkan field (max_completion_tokens, stop, dsb.).
 */
import type { HubMessage, HubPart, HubRequest, HubResponse, HubTool, HubToolChoice } from './types.js';
import { asArray, asNumber, asString, compact, isRecord, toOpenAIUser, toStopArray } from './util.js';

function normalizeParts(content: unknown): string | HubPart[] | null {
  if (typeof content === 'string' || content === null) return content;
  const parts: HubPart[] = [];
  for (const p of asArray(content)) {
    if (!isRecord(p)) continue;
    if (p.type === 'text' && typeof p.text === 'string') parts.push({ type: 'text', text: p.text });
    else if (p.type === 'image_url' && isRecord(p.image_url) && typeof p.image_url.url === 'string') {
      parts.push({ type: 'image_url', image_url: compact({ url: p.image_url.url, detail: asString(p.image_url.detail) }) });
    } else if (p.type === 'file' && isRecord(p.file)) {
      parts.push({
        type: 'file',
        file: compact({
          file_id: asString(p.file.file_id),
          file_data: asString(p.file.file_data),
          filename: asString(p.file.filename),
        }),
      });
    }
    // input_audio dll. tidak ditranslasi.
  }
  return parts;
}

export function chatRequestToHub(body: Record<string, unknown>): HubRequest {
  const messages: HubMessage[] = asArray(body.messages)
    .filter(isRecord)
    .map((m) =>
      compact({
        role: (asString(m.role) ?? 'user') as HubMessage['role'],
        content: normalizeParts(m.content ?? null),
        name: asString(m.name),
        tool_call_id: asString(m.tool_call_id),
        tool_calls: Array.isArray(m.tool_calls) ? (m.tool_calls as HubMessage['tool_calls']) : undefined,
        reasoning_content: asString(m.reasoning_content),
      }),
    );

  const tools = asArray(body.tools)
    .filter((t): t is HubTool => isRecord(t) && t.type === 'function' && isRecord(t.function))
    .map((t) => ({ type: 'function' as const, function: t.function }));

  return compact({
    model: asString(body.model) ?? '',
    messages,
    tools: tools.length ? tools : undefined,
    tool_choice: body.tool_choice as HubToolChoice | undefined,
    parallel_tool_calls: typeof body.parallel_tool_calls === 'boolean' ? body.parallel_tool_calls : undefined,
    max_tokens: asNumber(body.max_completion_tokens) ?? asNumber(body.max_tokens),
    temperature: asNumber(body.temperature),
    top_p: asNumber(body.top_p),
    stop: toStopArray(body.stop),
    stream: body.stream === true,
    user: asString(body.user),
    reasoning_effort: asString(body.reasoning_effort) as HubRequest['reasoning_effort'],
    response_format: isRecord(body.response_format) ? (body.response_format as HubRequest['response_format']) : undefined,
  });
}

export function hubToChatRequest(hub: HubRequest): Record<string, unknown> {
  return compact({
    model: hub.model,
    messages: hub.messages,
    tools: hub.tools,
    tool_choice: hub.tool_choice,
    parallel_tool_calls: hub.parallel_tool_calls,
    max_completion_tokens: hub.max_tokens,
    temperature: hub.temperature,
    top_p: hub.top_p,
    stop: hub.stop,
    stream: hub.stream || undefined,
    stream_options: hub.stream ? { include_usage: true } : undefined,
    user: toOpenAIUser(hub.user),
    reasoning_effort: hub.reasoning_effort,
    response_format: hub.response_format,
  });
}

export function chatResponseToHub(body: Record<string, unknown>): HubResponse {
  return body as unknown as HubResponse;
}

export function hubToChatResponse(hub: HubResponse): Record<string, unknown> {
  return hub as unknown as Record<string, unknown>;
}
