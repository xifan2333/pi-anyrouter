export type SseEvent = {
  event: string;
  data: string;
};

export function parseSseEvent(chunk: string): SseEvent {
  let event = "message";
  const data: string[] = [];
  for (const line of chunk.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  }
  return { event, data: data.join("\n") };
}

export function nextSseChunk(buffer: string): { chunk: string; rest: string } | undefined {
  const unix = buffer.indexOf("\n\n");
  const dos = buffer.indexOf("\r\n\r\n");
  if (unix === -1 && dos === -1) return undefined;
  if (dos !== -1 && (unix === -1 || dos < unix)) {
    return { chunk: buffer.slice(0, dos), rest: buffer.slice(dos + 4) };
  }
  return { chunk: buffer.slice(0, unix), rest: buffer.slice(unix + 2) };
}

/**
 * Async generator that consumes a ReadableStream and yields parsed SSE events.
 */
export async function* iterateSseEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    let parsedChunk = nextSseChunk(buffer);
    while (parsedChunk) {
      buffer = parsedChunk.rest;
      const event = parseSseEvent(parsedChunk.chunk);
      if (event.data) yield event;
      parsedChunk = nextSseChunk(buffer);
    }

    if (done) break;
  }

  const tail = buffer.trim();
  if (tail) {
    const event = parseSseEvent(tail);
    if (event.data) yield event;
  }
}
