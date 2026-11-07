import type { ApiType } from '../config/index.js';

/** Path upstream (relatif terhadap base-url) per api-type. */
const DEFAULT_PATH: Record<ApiType, string> = {
  'openai-completions': '/chat/completions',
  'openai-responses': '/responses',
  'anthropic-messages': '/messages',
  'openai-images': '/images/generations',
  'openai-audio': '/audio/speech',
  'openai-embeddings': '/embeddings',
  'openai-moderation': '/moderations',
  'openai-files': '/files',
  'anthropic-files': '/files',
  'openai-vector-stores': '/vector_stores',
};

/** Sub-path yang sah untuk endpoint multi-path. */
const VALID_SUBPATHS: Partial<Record<ApiType, string[]>> = {
  'openai-images': ['/images/generations', '/images/edits', '/images/variations'],
  'openai-audio': ['/audio/speech', '/audio/transcriptions', '/audio/translations'],
};

export function defaultUpstreamPath(apiType: ApiType): string {
  return DEFAULT_PATH[apiType];
}

/**
 * Path upstream untuk endpoint model non-chat. Path inbound dipakai bila
 * (tanpa prefix /v1) termasuk sub-path yang sah, jadi `/v1/audio/transcriptions`
 * diteruskan apa adanya, sedangkan url custom seperti `/images` jatuh ke default.
 */
export function upstreamPathFor(apiType: ApiType, inboundPath: string): string {
  const stripped = inboundPath.replace(/^\/v1(?=\/)/, '').replace(/\/+$/, '');
  const valid = VALID_SUBPATHS[apiType];
  if (valid?.includes(stripped)) return stripped;
  return DEFAULT_PATH[apiType];
}
