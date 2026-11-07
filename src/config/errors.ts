export interface ConfigIssue {
  /** Path field, mis. `routes[0].models[1]`. Kosong = root. */
  path: string;
  message: string;
}

export class ConfigError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[], source?: string) {
    const header = source ? `Config tidak valid (${source}):` : 'Config tidak valid:';
    const lines = issues.map((i) => `  - ${i.path || '(root)'}: ${i.message}`);
    super([header, ...lines].join('\n'));
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out ? `.${String(part)}` : String(part);
  }
  return out;
}
