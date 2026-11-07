import { type ConfigIssue, formatPath } from './errors.js';

const PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Ganti `${VAR}` dan `${VAR:-default}` di semua string (rekursif) dengan nilai env.
 * Dikerjakan setelah YAML di-parse, jadi komentar YAML tidak ikut diproses.
 * Variabel yang tidak ada / kosong tanpa default dicatat sebagai issue.
 */
export function interpolateEnv(
  value: unknown,
  env: Env,
  issues: ConfigIssue[],
  path: PropertyKey[] = [],
): unknown {
  if (typeof value === 'string') {
    return value.replace(PATTERN, (_match, name: string, fallback: string | undefined) => {
      const resolved = env[name];
      if (resolved !== undefined && resolved !== '') return resolved;
      if (fallback !== undefined) return fallback;
      issues.push({
        path: formatPath(path),
        message: `environment variable \${${name}} tidak di-set`,
      });
      return '';
    });
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => interpolateEnv(item, env, issues, [...path, i]));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = interpolateEnv(item, env, issues, [...path, key]);
    }
    return out;
  }
  return value;
}
