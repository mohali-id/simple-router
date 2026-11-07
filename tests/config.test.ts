import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseConfig } from '../src/config/index.js';

const ENV = {
  ROUTER_API_KEY: 'sk-router-test-123',
  OPENAI_API_KEY: 'sk-openai-test',
  ANTHROPIC_API_KEY: 'sk-ant-test',
};

const MINIMAL = `
application:
  auth:
    - type: api-key
      name: test
      key: sk-test-12345678
providers:
  - id: openai
    base-url: https://api.openai.com/v1/
    api-key: sk-openai
models:
  - id: gpt-x
    provider: openai
    api-type: openai-completions
routes:
  - id: "gpt-x "
    models: [" openai/gpt-x"]
`;

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err.issues.map((i) => `${i.path}: ${i.message}`);
    throw err;
  }
  throw new Error('expected ConfigError');
}

describe('parseConfig', () => {
  it('memuat config minimal dengan default server', () => {
    const config = parseConfig(MINIMAL, { env: {} });
    expect(config.server).toEqual({
      host: '127.0.0.1',
      port: 20128,
      timeoutMs: 600_000,
      cooldownMs: 60_000,
      hotReload: true,
    });
    expect(config.providers[0]?.type).toBe('openai');
    expect(config.providers[0]?.baseUrl).toBe('https://api.openai.com/v1');
    expect(config.models[0]).toMatchObject({ ref: 'openai/gpt-x', apiType: 'openai-completions' });
  });

  it('men-trim id route dan referensi model', () => {
    const config = parseConfig(MINIMAL, { env: {} });
    expect(config.routes[0]).toEqual({ id: 'gpt-x', name: undefined, models: ['openai/gpt-x'] });
  });

  it('memuat config.example.yaml', () => {
    const text = readFileSync(new URL('../config.example.yaml', import.meta.url), 'utf8');
    const config = parseConfig(text, { env: ENV });
    expect(config.application.auth[0]?.key).toBe(ENV.ROUTER_API_KEY);
    expect(config.application.resources.vectorStores).toEqual({ provider: 'openai' });
    expect(config.routes.find((r) => r.id === 'opus-5-5')?.models).toEqual([
      'anthropic/claude-opus-5-5',
      'openai/gpt-6-astra',
    ]);
    const files = config.application.endpoints.find((e) => e.id === 'openai-files');
    expect(files?.methods).toEqual(['GET', 'POST', 'DELETE']);
  });

  it('HOST/PORT dari env meng-override server', () => {
    const config = parseConfig(MINIMAL, { env: { HOST: '0.0.0.0', PORT: '8080' } });
    expect(config.server.host).toBe('0.0.0.0');
    expect(config.server.port).toBe(8080);
  });
});

describe('interpolasi env', () => {
  it('mengganti ${VAR} dan memakai ${VAR:-default}', () => {
    const text = MINIMAL.replace('sk-openai', '${OPENAI_KEY}').replace(
      'https://api.openai.com/v1/',
      '${OPENAI_BASE:-https://example.com/v1}',
    );
    const config = parseConfig(text, { env: { OPENAI_KEY: 'sk-from-env' } });
    expect(config.providers[0]).toMatchObject({ apiKey: 'sk-from-env', baseUrl: 'https://example.com/v1' });
  });

  it('error jika variabel tidak di-set', () => {
    const text = MINIMAL.replace('sk-openai', '${MISSING_KEY}');
    const issues = issuesOf(() => parseConfig(text, { env: {} }));
    expect(issues).toContain('providers[0].api-key: environment variable ${MISSING_KEY} tidak di-set');
  });

  it('tidak memproses ${VAR} di dalam komentar YAML', () => {
    const config = parseConfig(`# key: \${NOT_SET}\n${MINIMAL}`, { env: {} });
    expect(config.routes).toHaveLength(1);
  });
});

describe('validasi', () => {
  it('menolak referensi yang rusak', () => {
    const text = `
application:
  auth:
    - { type: api-key, name: a, key: sk-aaaaaaaa }
  resources:
    files: { provider: nope }
providers:
  - { id: openai, base-url: https://api.openai.com/v1, api-key: x }
models:
  - { id: m1, provider: ghost, api-type: openai-completions }
  - { id: m2, provider: openai, api-type: magic-api }
routes:
  - id: r1
    models: [openai/missing, no-slash]
`;
    const issues = issuesOf(() => parseConfig(text, { env: {} }));
    expect(issues).toEqual(
      expect.arrayContaining([
        'models[0].provider: provider "ghost" tidak ada di providers',
        expect.stringContaining('models[1].api-type: api-type "magic-api" tidak dikenal'),
        'routes[0].models[0]: model "openai/missing" tidak ada di models',
        'routes[0].models[1]: "no-slash" harus berformat provider/model-id',
        'application.resources.files.provider: provider "nope" tidak ada di providers',
      ]),
    );
  });

  it('menolak id duplikat', () => {
    const text = `${MINIMAL}
  - id: gpt-x
    models: [openai/gpt-x]
`;
    const issues = issuesOf(() => parseConfig(text, { env: {} }));
    expect(issues).toContain('routes[1].id: id "gpt-x" duplikat');
  });

  it('menolak api-type yang tidak terdaftar di katalog api-types', () => {
    const text = MINIMAL.replace(
      'application:\n',
      'application:\n  api-types:\n    - id: openai-responses\n',
    );
    const issues = issuesOf(() => parseConfig(text, { env: {} }));
    expect(issues).toContain(
      'models[0].api-type: api-type "openai-completions" belum didaftarkan di application.api-types',
    );
  });

  it('menolak field yang tidak dikenal (typo)', () => {
    const text = MINIMAL.replace('base-url:', 'baseurl: x\n    base-url:');
    const issues = issuesOf(() => parseConfig(text, { env: {} }));
    expect(issues.some((i) => i.startsWith('providers[0]:') && i.includes('baseurl'))).toBe(true);
  });

  it('menolak YAML rusak', () => {
    const issues = issuesOf(() => parseConfig('a: [1, 2', { env: {} }));
    expect(issues[0]).toMatch(/^: YAML tidak valid/);
  });
});

describe('loadConfig', () => {
  it('error jelas jika file tidak ada', async () => {
    await expect(loadConfig('./tidak-ada.yaml', { env: {} })).rejects.toThrow(/tidak-ada\.yaml[\s\S]*file tidak ditemukan/);
  });
});
