import type { Config } from './config/index.js';
import type { ErrorFormat } from './errors.js';
import type { Logger } from './logger.js';
import type { RouterState } from './state.js';

/** Dependensi bersama untuk semua handler. */
export interface RouterContext {
  config: Config;
  state: RouterState;
  logger: Logger;
  fetch: typeof fetch;
}

/** Variabel per-request di Hono context. */
export interface AppEnv {
  Variables: {
    reqId: string;
    errorFormat: ErrorFormat;
    route?: string;
    target?: string;
    fallbacks?: number;
  };
}
