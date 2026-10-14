import { fetch as undiciFetch } from "undici";
import { getProxyAgent, getProxyUrl } from "./proxy.js";
import {
  delay,
  getRetryDelayMs,
  isRetryableStatus,
  parseRetryAfterMs,
  DEFAULT_MAX_RETRIES,
} from "./retry.js";
import { extractRequestId, tryParseJson } from "../utils/index.js";
import { setDiagnosticsField } from "../diagnostics/index.js";

export async function fetchWithProxy(url: string, init: RequestInit): Promise<Response> {
  const proxyUrl = getProxyUrl(url);
  if (!proxyUrl) {
    return fetch(url, init);
  }
  return undiciFetch(url, {
    ...init,
    dispatcher: getProxyAgent(proxyUrl),
  } as any) as unknown as Promise<Response>;
}

export interface SseRequestOptions {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
  onResponse?: (response: Response) => void;
  onRetry?: (status: number, attempt: number, maxRetries: number) => void;
}

export async function postSseWithRetry(options: SseRequestOptions): Promise<Response> {
  const maxRetries = DEFAULT_MAX_RETRIES;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response;
    try {
      response = await fetchWithProxy(options.url, {
        method: "POST",
        signal: options.signal,
        headers: options.headers,
        body: options.body,
      });
    } catch (error) {
      if (attempt < maxRetries && !options.signal?.aborted) {
        await delay(getRetryDelayMs(attempt));
        continue;
      }
      throw error;
    }

    setDiagnosticsField("status", response.status);
    setDiagnosticsField("endpoint", options.url);
    setDiagnosticsField("retryAttempt", attempt);

    const contentType = response.headers.get("content-type") || "";
    if (response.ok && contentType.includes("text/event-stream")) {
      const reqId = response.headers.get("x-oneapi-request-id") || undefined;
      setDiagnosticsField("requestId", reqId);
      if (options.onResponse) {
        try {
          options.onResponse(response);
        } catch {
          // Best-effort hook
        }
      }
      return response;
    }

    const raw = await response.text();
    const parsed = tryParseJson(raw) || { raw };
    const requestId = extractRequestId(parsed, response.headers);
    setDiagnosticsField("requestId", requestId);

    if (!response.ok && attempt < maxRetries && isRetryableStatus(response.status)) {
      if (options.onRetry) {
        options.onRetry(response.status, attempt + 1, maxRetries);
      }
      await delay(
        getRetryDelayMs(attempt, parseRetryAfterMs(response.headers.get("retry-after"))),
      );
      continue;
    }

    if (response.ok) {
      throw new Error(`Stream response was not SSE (content-type=${contentType || "<missing>"})`);
    }
    throw new Error(raw || `HTTP ${response.status}`);
  }

  throw new Error("HTTP request failed after retries");
}
