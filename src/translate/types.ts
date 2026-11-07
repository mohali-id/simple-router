/**
 * Format hub internal = OpenAI Chat Completions (subset yang ditranslasi).
 * Semua translator mengubah format lain ke/dari bentuk ini.
 */

export type HubRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export type HubPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }
  | { type: 'file'; file: { file_id?: string; file_data?: string; filename?: string } };

export interface HubToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface HubMessage {
  role: HubRole;
  content: string | HubPart[] | null;
  name?: string;
  tool_calls?: HubToolCall[];
  tool_call_id?: string;
  /** Teks reasoning/thinking (non-standar, dipakai beberapa provider). */
  reasoning_content?: string;
}

export interface HubTool {
  type: 'function';
  function: { name: string; description?: string; parameters?: unknown; strict?: boolean };
}

export type HubToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };

export interface HubRequest {
  model: string;
  messages: HubMessage[];
  tools?: HubTool[];
  tool_choice?: HubToolChoice;
  parallel_tool_calls?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  user?: string;
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high';
  response_format?:
    | { type: 'text' }
    | { type: 'json_object' }
    | { type: 'json_schema'; json_schema: { name: string; schema?: unknown; strict?: boolean; description?: string } };
}

export type HubFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter';

export interface HubUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface HubResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: HubToolCall[];
      reasoning_content?: string;
      refusal?: string | null;
    };
    finish_reason: HubFinishReason | null;
  }[];
  usage?: HubUsage;
}

export interface HubToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

export interface HubChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: {
    index: number;
    delta: {
      role?: 'assistant';
      content?: string | null;
      reasoning_content?: string;
      tool_calls?: HubToolCallDelta[];
    };
    finish_reason: HubFinishReason | null;
  }[];
  usage?: HubUsage | null;
}

/** Fitur yang tidak bisa ditranslasi → target dilewati (fallback). */
export class TranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranslationError';
  }
}
