import type { ApiType } from './api-types.js';

/** Config yang sudah divalidasi & dinormalisasi (camelCase). */
export interface Config {
  server: {
    host: string;
    port: number;
    timeoutMs: number;
    cooldownMs: number;
    hotReload: boolean;
    /** Prefix path ternormalisasi (`/router`) atau '' bila tanpa prefix. */
    basePath: string;
  };
  application: {
    name: string;
    version?: string;
    description?: string;
    auth: ClientKey[];
    endpoints: Endpoint[];
    apiTypes: { id: ApiType; name?: string; description?: string }[];
    resources: {
      files?: { provider: string };
      vectorStores?: { provider: string };
    };
  };
  providers: Provider[];
  models: Model[];
  routes: Route[];
}

export interface ClientKey {
  type: 'api-key';
  name: string;
  key: string;
}

export interface Endpoint {
  id: ApiType;
  url: string;
  methods: string[];
  description?: string;
}

export interface Provider {
  id: string;
  name?: string;
  type: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey: string;
}

export interface Model {
  /** Nama model di provider upstream, mis. `gpt-6-astra`. */
  id: string;
  /** `provider/id`, dipakai sebagai referensi di routes. */
  ref: string;
  name?: string;
  provider: string;
  apiType: ApiType;
  description?: string;
  capabilities: string[];
}

export interface Route {
  id: string;
  name?: string;
  /** Rantai fallback berurutan, berupa referensi `provider/model-id`. */
  models: string[];
}
