/**
 * Logger satu baris. Jangan pernah mengirim API key atau isi prompt ke sini.
 * LOG_LEVEL: debug | info | warn | error | silent (default info).
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
type Level = Exclude<keyof typeof LEVELS, 'silent'>;

export type LogFields = Record<string, string | number | boolean | undefined | null>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

function format(fields?: LogFields): string {
  if (!fields) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    const s = String(v);
    parts.push(`${k}=${/\s/.test(s) ? JSON.stringify(s) : s}`);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

export function createLogger(level: string = process.env.LOG_LEVEL ?? 'info'): Logger {
  const min = LEVELS[(level as keyof typeof LEVELS) in LEVELS ? (level as keyof typeof LEVELS) : 'info'];
  const log = (lvl: Level) => (msg: string, fields?: LogFields) => {
    if (LEVELS[lvl] < min) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${msg}${format(fields)}`;
    if (lvl === 'error' || lvl === 'warn') console.error(line);
    else console.log(line);
  };
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
