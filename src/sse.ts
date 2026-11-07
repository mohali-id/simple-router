/**
 * Parser & writer Server-Sent Events minimal.
 */
export interface SseEvent {
  event?: string;
  data: string;
}

/** Parse stream byte SSE menjadi event. Membatalkan stream sumber saat iterasi dihentikan. */
export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event: string | undefined;
  let data: string[] = [];
  let finished = false;

  const flushLine = function* (line: string): Generator<SseEvent> {
    if (line === '') {
      if (data.length) yield { event, data: data.join('\n') };
      event = undefined;
      data = [];
      return;
    }
    if (line.startsWith(':')) return; // komentar / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.search(/\r\n|\r|\n/)) !== -1) {
        // `\r` di ujung buffer bisa jadi awal `\r\n` yang terpotong antar chunk: tunggu data berikutnya.
        if (buffer[idx] === '\r' && idx === buffer.length - 1) break;
        const line = buffer.slice(0, idx);
        const sepLen = buffer.startsWith('\r\n', idx) ? 2 : 1;
        buffer = buffer.slice(idx + sepLen);
        yield* flushLine(line);
      }
    }
    buffer += decoder.decode();
    for (const line of buffer.split(/\r\n|\r|\n/)) if (line) yield* flushLine(line);
    yield* flushLine('');
    finished = true;
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Format satu event SSE. `data` objek akan di-JSON-kan. */
export function formatSse(data: unknown, event?: string): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `${event ? `event: ${event}\n` : ''}data: ${payload}\n\n`;
}
