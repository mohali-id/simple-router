/**
 * State in-memory yang bertahan saat config di-reload (tanpa database).
 */
export interface RouterState {
  /** model ref (`provider/model`) -> timestamp (ms) sampai kapan di-cooldown. */
  cooldownUntil: Map<string, number>;
}

export function createState(): RouterState {
  return { cooldownUntil: new Map() };
}

export function markFailed(state: RouterState, ref: string, cooldownMs: number, now = Date.now()): void {
  if (cooldownMs > 0) state.cooldownUntil.set(ref, now + cooldownMs);
}

export function markHealthy(state: RouterState, ref: string): void {
  state.cooldownUntil.delete(ref);
}

export function isCoolingDown(state: RouterState, ref: string, now = Date.now()): boolean {
  const until = state.cooldownUntil.get(ref);
  if (until === undefined) return false;
  if (until <= now) {
    state.cooldownUntil.delete(ref);
    return false;
  }
  return true;
}
