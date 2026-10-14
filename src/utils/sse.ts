export type SseEvent = {
  event: string;
  data: string;
};

export function parseSseEvent(chunk: string): SseEvent {
  let event = "message";
  const data: string[] = [];
  for (const line of chunk.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
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
