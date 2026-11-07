/**
 * Membungkus body respons SSE untuk logging: event pertama (TTFB), tiap event,
 * dan akhir stream (selesai / dibatalkan client / error). Hanya metadata yang
 * dicatat (tipe event, ukuran), TIDAK PERNAH isi event (bisa berisi prompt/jawaban).
 */
import type { LogFields, Logger } from './logger.js';

export interface StreamLogOptions {
  logger: Logger;
  /** Field yang ikut di setiap baris log (req, route, target, ...). */
  fields: LogFields;
  /** Waktu mulai request (performance.now()). */
  startedAt: number;
}

interface EventInfo {
  name: string;
  bytes: number;
}

/** Pemindai SSE ringan: hanya mengambil nama event & ukuran, tanpa menyimpan isi. */
function createEventScanner() {
  const decoder = new TextDecoder();
  let buffer = '';
  let name: string | undefined;
  let bytes = 0;
  let firstData = '';

  return (chunk: Uint8Array | undefined): EventInfo[] => {
    buffer += chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode();
    const events: EventInfo[] = [];
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line === '') {
        if (bytes > 0) events.push({ name: name ?? classify(firstData), bytes });
        name = undefined;
        bytes = 0;
        firstData = '';
        continue;
      }
      bytes += line.length + 1;
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:') && !firstData) firstData = line.slice(5).trim();
    }
    return events;
  };
}

/** Untuk stream tanpa `event:` (Chat Completions): bedakan chunk, [DONE], dan error. */
function classify(data: string): string {
  if (data === '[DONE]') return 'done';
  if (data.startsWith('{"error"')) return 'error';
  return 'chunk';
}

export function logStream(body: ReadableStream<Uint8Array>, options: StreamLogOptions): ReadableStream<Uint8Array> {
  const { logger, fields, startedAt } = options;
  const reader = body.getReader();
  const scan = createEventScanner();
  let count = 0;
  let totalBytes = 0;
  let sawError = false;
  let finished = false;

  const elapsed = () => Math.round(performance.now() - startedAt);

  const record = (events: EventInfo[]) => {
    for (const ev of events) {
      count += 1;
      if (ev.name === 'error') sawError = true;
      if (count === 1) logger.info('stream first event', { ...fields, event: ev.name, ttfb_ms: elapsed() });
      logger.debug('stream event', { ...fields, n: count, event: ev.name, bytes: ev.bytes });
    }
  };

  const finish = (outcome: 'completed' | 'aborted' | 'failed', reason?: string) => {
    if (finished) return;
    finished = true;
    const log = outcome === 'completed' && !sawError ? logger.info : logger.warn;
    log('stream done', {
      ...fields,
      outcome: outcome === 'completed' && sawError ? 'completed_with_error' : outcome,
      events: count,
      bytes: totalBytes,
      ms: elapsed(),
      reason,
    });
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          record(scan(undefined));
          finish('completed');
          controller.close();
          return;
        }
        totalBytes += value.byteLength;
        record(scan(value));
        controller.enqueue(value);
      } catch (err) {
        finish('failed', err instanceof Error ? err.message : String(err));
        controller.error(err);
      }
    },
    async cancel(reason) {
      finish('aborted', 'client memutus koneksi');
      await reader.cancel(reason).catch(() => {});
    },
  });
}
