import { RouterError } from '../errors.js';
import { readJsonSafe } from '../http.js';
import type { Logger } from '../logger.js';
import { UpstreamNetworkError, UpstreamTimeoutError } from '../providers/client.js';
import { extractErrorMessage } from '../errors.js';
import { markFailed, markHealthy, type RouterState } from '../state.js';
import type { Target } from './resolve.js';

/** Hasil satu percobaan target. */
export type AttemptOutcome =
  /** Respons final untuk client (sukses, atau error yang tidak di-fallback). */
  | { type: 'done'; response: Response; success: boolean }
  /** Lanjut ke target berikutnya. `cooldown` = tandai target bermasalah. */
  | { type: 'next'; status: number; message: string; cooldown: boolean };

export interface Failure {
  ref: string;
  status: number;
  message: string;
}

export interface FallbackResult {
  response?: Response;
  target?: Target;
  failures: Failure[];
}

export interface FallbackContext {
  state: RouterState;
  cooldownMs: number;
  logger: Logger;
  reqId: string;
}

/** Status upstream yang memicu fallback. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Untuk respons upstream non-2xx: bila bisa di-fallback, kembalikan outcome `next`
 * (body dibaca untuk pesan error); bila tidak, kembalikan undefined.
 */
export async function retryOutcome(res: Response): Promise<AttemptOutcome | undefined> {
  if (!isRetryableStatus(res.status)) return undefined;
  const body = await readJsonSafe(res);
  return {
    type: 'next',
    status: res.status,
    message: extractErrorMessage(body, `upstream HTTP ${res.status}`),
    cooldown: true,
  };
}

/**
 * Coba target berurutan sampai ada outcome `done`.
 * Error jaringan/timeout dan RouterError dari attempt dianggap `next`.
 */
export async function tryTargets(
  targets: readonly Target[],
  ctx: FallbackContext,
  attempt: (target: Target) => Promise<AttemptOutcome>,
): Promise<FallbackResult> {
  const failures: Failure[] = [];
  for (const target of targets) {
    const ref = target.model.ref;
    let outcome: AttemptOutcome;
    try {
      outcome = await attempt(target);
    } catch (err) {
      if (err instanceof UpstreamTimeoutError) outcome = { type: 'next', status: 504, message: err.message, cooldown: true };
      else if (err instanceof UpstreamNetworkError) outcome = { type: 'next', status: 502, message: err.message, cooldown: true };
      else if (err instanceof RouterError) outcome = { type: 'next', status: err.status, message: err.message, cooldown: false };
      else throw err;
    }

    if (outcome.type === 'done') {
      if (outcome.success) markHealthy(ctx.state, ref);
      return { response: outcome.response, target, failures };
    }

    failures.push({ ref, status: outcome.status, message: outcome.message });
    if (outcome.cooldown) markFailed(ctx.state, ref, ctx.cooldownMs);
    ctx.logger.warn('target gagal, coba berikutnya', {
      req: ctx.reqId,
      target: ref,
      status: outcome.status,
      reason: outcome.message.slice(0, 200),
    });
  }
  return { failures };
}

/** Error final saat semua target gagal. */
export function allFailedError(failures: readonly Failure[]): RouterError {
  const last = failures.at(-1);
  if (!last) return new RouterError(502, 'tidak ada target yang bisa dicoba', 'no_target');
  if (failures.length === 1) return new RouterError(last.status, last.message);
  const summary = failures.map((f) => `${f.ref} (${f.status})`).join(', ');
  return new RouterError(last.status, `semua target gagal: ${summary}. Terakhir: ${last.message}`);
}
