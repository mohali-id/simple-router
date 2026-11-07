import type { Config, Model, Provider } from '../config/index.js';
import { RouterError } from '../errors.js';
import { isCoolingDown, type RouterState } from '../state.js';

export interface Target {
  model: Model;
  provider: Provider;
}

export interface Resolved {
  /** Route id, atau ref `provider/model` bila dipanggil langsung. */
  routeId: string;
  targets: Target[];
}

export interface ResolveOptions {
  /** Dari header `x-router-provider`: hanya pakai target milik provider ini. */
  provider?: string;
}

/**
 * Ubah nilai `model` dari client menjadi daftar target berurutan.
 * Target yang sedang cooldown dipindah ke akhir (tidak dibuang), supaya
 * request tetap dicoba bila semua target sedang cooldown.
 */
export function resolveModel(
  config: Config,
  state: RouterState,
  requested: string,
  options: ResolveOptions = {},
): Resolved {
  const name = requested.trim();
  const modelsByRef = new Map(config.models.map((m) => [m.ref, m]));
  const providers = new Map(config.providers.map((p) => [p.id, p]));

  const route = config.routes.find((r) => r.id === name);
  let refs: string[];
  if (route) refs = route.models;
  else if (modelsByRef.has(name)) refs = [name];
  else throw new RouterError(404, `model "${name}" tidak ditemukan`, 'model_not_found');

  let targets: Target[] = [];
  for (const ref of refs) {
    const model = modelsByRef.get(ref);
    const provider = model && providers.get(model.provider);
    if (model && provider) targets.push({ model, provider });
  }

  if (options.provider) {
    const wanted = options.provider.trim();
    targets = targets.filter((t) => t.provider.id === wanted);
    if (targets.length === 0) {
      throw new RouterError(400, `model "${name}" tidak punya target di provider "${wanted}" (x-router-provider)`, 'provider_mismatch');
    }
  }

  const healthy = targets.filter((t) => !isCoolingDown(state, t.model.ref));
  const cooling = targets.filter((t) => isCoolingDown(state, t.model.ref));
  return { routeId: route?.id ?? name, targets: [...healthy, ...cooling] };
}
