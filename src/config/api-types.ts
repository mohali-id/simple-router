/**
 * Format API yang dipahami router. `application.api-types[]` dan
 * `models[].api-type` di config harus memakai salah satu dari id ini.
 */
export const KNOWN_API_TYPES = [
  'openai-completions', // OpenAI Chat Completions (/v1/chat/completions)
  'openai-responses',
  'anthropic-messages',
  'openai-images',
  'openai-audio',
  'openai-embeddings',
  'openai-moderation',
  'openai-files',
  'anthropic-files',
  'openai-vector-stores',
] as const;

export type ApiType = (typeof KNOWN_API_TYPES)[number];

/** Format chat yang bisa saling ditranslasi. */
export const CHAT_API_TYPES: readonly ApiType[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
];

export function isKnownApiType(value: string): value is ApiType {
  return (KNOWN_API_TYPES as readonly string[]).includes(value);
}
