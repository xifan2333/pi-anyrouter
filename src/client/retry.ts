export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableStatus(status: number): boolean {
  return [408, 409, 429, 500, 502, 503, 504, 520, 522, 524].includes(status);
}

export function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  if (Number.isFinite(at)) {
    const delta = at - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

export function getRetryDelayMs(attempt: number, retryAfterMs?: number): number {
  if (typeof retryAfterMs === "number") {
    return Math.max(0, Math.min(retryAfterMs, 30_000));
  }
  const base = Math.min(1000 * 2 ** attempt, 15_000);
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

export function getMaxRetries(): number {
  return Math.max(0, Number(process.env.PI_ANYROUTER_CC_MAX_RETRIES || "10") || 0);
}
