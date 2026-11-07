import { type ApiType, isKnownApiType, KNOWN_API_TYPES } from './api-types.js';
import type { ConfigIssue } from './errors.js';
import type { RawConfig } from './schema.js';
import type { Config, Endpoint, Model } from './types.js';

/** Tebak gaya provider dari host base-url (api.anthropic.com → anthropic). */
export function inferProviderType(baseUrl: string): 'openai' | 'anthropic' {
  return new URL(baseUrl).hostname.endsWith('anthropic.com') ? 'anthropic' : 'openai';
}

/**
 * Validasi silang antar bagian config (referensi, duplikat, api-type)
 * lalu kembalikan bentuk ternormalisasi. Issue ditambahkan ke `issues`;
 * hasil hanya boleh dipakai bila `issues` kosong.
 */
export function validateAndNormalize(raw: RawConfig, issues: ConfigIssue[]): Config {
  const app = raw.application;
  const known = KNOWN_API_TYPES.join(', ');

  // --- api-types --------------------------------------------------------
  const declaredApiTypes = new Set<string>();
  app['api-types'].forEach((t, i) => {
    if (!isKnownApiType(t.id)) {
      issues.push({ path: `application.api-types[${i}].id`, message: `api-type "${t.id}" tidak dikenal (pilihan: ${known})` });
    }
    if (declaredApiTypes.has(t.id)) {
      issues.push({ path: `application.api-types[${i}].id`, message: `id "${t.id}" duplikat` });
    }
    declaredApiTypes.add(t.id);
  });

  /** api-type harus dikenal router, dan (jika katalog diisi) terdaftar di api-types. */
  const checkApiType = (value: string, path: string): value is ApiType => {
    if (!isKnownApiType(value)) {
      issues.push({ path, message: `api-type "${value}" tidak dikenal (pilihan: ${known})` });
      return false;
    }
    if (declaredApiTypes.size > 0 && !declaredApiTypes.has(value)) {
      issues.push({ path, message: `api-type "${value}" belum didaftarkan di application.api-types` });
      return false;
    }
    return true;
  };

  // --- auth -------------------------------------------------------------
  const seenKeys = new Set<string>();
  const seenNames = new Set<string>();
  app.auth.forEach((a, i) => {
    if (seenKeys.has(a.key)) issues.push({ path: `application.auth[${i}].key`, message: 'API key duplikat' });
    if (seenNames.has(a.name)) issues.push({ path: `application.auth[${i}].name`, message: `nama "${a.name}" duplikat` });
    seenKeys.add(a.key);
    seenNames.add(a.name);
  });

  // --- endpoints --------------------------------------------------------
  const endpoints: Endpoint[] = [];
  const seenRoutesHttp = new Set<string>();
  app.endpoints.forEach((e, i) => {
    const methods = Array.isArray(e.method) ? [...new Set(e.method)] : [e.method];
    for (const m of methods) {
      const key = `${m} ${e.url}`;
      if (seenRoutesHttp.has(key)) {
        issues.push({ path: `application.endpoints[${i}]`, message: `endpoint "${key}" duplikat` });
      }
      seenRoutesHttp.add(key);
    }
    if (checkApiType(e.id, `application.endpoints[${i}].id`)) {
      endpoints.push({ id: e.id, url: e.url, methods, description: e.description });
    }
  });

  // --- providers --------------------------------------------------------
  const providerIds = new Set<string>();
  raw.providers.forEach((p, i) => {
    if (providerIds.has(p.id)) issues.push({ path: `providers[${i}].id`, message: `id "${p.id}" duplikat` });
    providerIds.add(p.id);
  });

  // --- models -----------------------------------------------------------
  const models: Model[] = [];
  const modelRefs = new Set<string>();
  raw.models.forEach((m, i) => {
    const ref = `${m.provider}/${m.id}`;
    if (!providerIds.has(m.provider)) {
      issues.push({ path: `models[${i}].provider`, message: `provider "${m.provider}" tidak ada di providers` });
    }
    if (modelRefs.has(ref)) {
      issues.push({ path: `models[${i}].id`, message: `model "${ref}" duplikat` });
    }
    modelRefs.add(ref);
    const apiType = m['api-type'];
    if (checkApiType(apiType, `models[${i}].api-type`)) {
      models.push({
        id: m.id,
        ref,
        name: m.name,
        provider: m.provider,
        apiType,
        description: m.description,
        capabilities: m.capabilities,
      });
    }
  });

  // --- routes -----------------------------------------------------------
  const routeIds = new Set<string>();
  raw.routes.forEach((r, i) => {
    if (routeIds.has(r.id)) issues.push({ path: `routes[${i}].id`, message: `id "${r.id}" duplikat` });
    routeIds.add(r.id);
    r.models.forEach((ref, j) => {
      const path = `routes[${i}].models[${j}]`;
      if (!ref.includes('/')) {
        issues.push({ path, message: `"${ref}" harus berformat provider/model-id` });
      } else if (!modelRefs.has(ref)) {
        issues.push({ path, message: `model "${ref}" tidak ada di models` });
      }
    });
    if (new Set(r.models).size !== r.models.length) {
      issues.push({ path: `routes[${i}].models`, message: 'berisi model duplikat' });
    }
  });

  // --- provider type vs api-type -----------------------------------------
  const providerType = new Map(raw.providers.map((p) => [p.id, p.type ?? inferProviderType(p['base-url'])]));
  raw.models.forEach((m, i) => {
    const type = providerType.get(m.provider);
    const api = m['api-type'];
    if (type === 'anthropic' && isKnownApiType(api) && !api.startsWith('anthropic-')) {
      issues.push({ path: `models[${i}].api-type`, message: `provider "${m.provider}" bertipe anthropic, api-type "${api}" tidak didukung` });
    }
  });

  // --- resources --------------------------------------------------------
  const res = app.resources;
  for (const [key, target] of [['files', res.files], ['vector-stores', res['vector-stores']]] as const) {
    if (target && !providerIds.has(target.provider)) {
      issues.push({
        path: `application.resources.${key}.provider`,
        message: `provider "${target.provider}" tidak ada di providers`,
      });
    }
  }

  return {
    server: {
      host: raw.server.host,
      port: raw.server.port,
      timeoutMs: raw.server['timeout-ms'],
      cooldownMs: raw.server['cooldown-ms'],
      hotReload: raw.server['hot-reload'],
    },
    application: {
      name: app.name,
      version: app.version,
      description: app.description,
      auth: app.auth,
      endpoints,
      apiTypes: app['api-types']
        .filter((t): t is typeof t & { id: ApiType } => isKnownApiType(t.id))
        .map((t) => ({ id: t.id, name: t.name, description: t.description })),
      resources: {
        files: res.files,
        vectorStores: res['vector-stores'],
      },
    },
    providers: raw.providers.map((p) => ({
      id: p.id,
      name: p.name,
      type: providerType.get(p.id) ?? 'openai',
      baseUrl: p['base-url'],
      apiKey: p['api-key'],
    })),
    models,
    routes: raw.routes.map((r) => ({ id: r.id, name: r.name, models: r.models })),
  };
}
