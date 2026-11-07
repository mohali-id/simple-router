import { readFile } from 'node:fs/promises';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { ConfigError, type ConfigIssue, formatPath } from './errors.js';
import { type Env, interpolateEnv } from './interpolate.js';
import { rawConfigSchema } from './schema.js';
import type { Config } from './types.js';
import { validateAndNormalize } from './validate.js';

export interface LoadOptions {
  env?: Env;
  /** Nama sumber untuk pesan error (mis. path file). */
  source?: string;
}

/**
 * Parse teks YAML menjadi Config tervalidasi.
 * Melempar ConfigError berisi semua issue yang ditemukan.
 */
export function parseConfig(text: string, options: LoadOptions = {}): Config {
  const { env = process.env, source } = options;

  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (err) {
    const message = err instanceof YAMLParseError ? err.message : String(err);
    throw new ConfigError([{ path: '', message: `YAML tidak valid: ${message}` }], source);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new ConfigError([{ path: '', message: 'isi config harus berupa object YAML' }], source);
  }

  const issues: ConfigIssue[] = [];
  const interpolated = interpolateEnv(data, env, issues);
  // Env yang hilang menghasilkan string kosong; laporkan sekarang agar tidak
  // diikuti error schema turunan ("minimal 8 karakter", dst.).
  if (issues.length > 0) throw new ConfigError(issues, source);

  // Override server dari env (HOST / PORT) sebelum validasi schema.
  const withEnv = applyServerEnv(interpolated as Record<string, unknown>, env);

  const parsed = rawConfigSchema.safeParse(withEnv);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({ path: formatPath(issue.path), message: issue.message });
    }
    throw new ConfigError(issues, source);
  }

  const config = validateAndNormalize(parsed.data, issues);
  if (issues.length > 0) throw new ConfigError(issues, source);
  return config;
}

/** Baca & parse file config. */
export async function loadConfig(path: string, options: Omit<LoadOptions, 'source'> = {}): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const message = code === 'ENOENT' ? `file tidak ditemukan` : `gagal membaca file (${code ?? String(err)})`;
    throw new ConfigError([{ path: '', message }], path);
  }
  return parseConfig(text, { ...options, source: path });
}

function applyServerEnv(data: Record<string, unknown>, env: Env): Record<string, unknown> {
  const host = env.HOST?.trim();
  const port = env.PORT?.trim();
  const basePath = env.BASE_PATH;
  if (!host && !port && basePath === undefined) return data;
  const server = { ...((data.server as Record<string, unknown> | undefined) ?? {}) };
  if (host) server.host = host;
  if (port) server.port = port;
  if (basePath !== undefined) server['base-path'] = basePath;
  return { ...data, server };
}
