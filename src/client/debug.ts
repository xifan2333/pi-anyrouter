import type { Json } from "../types/index.js";

export function isDebugEnabled(): boolean {
  return false;
}

export function writeDebugFile(
  _kind: "request" | "response" | "error",
  _modelId: string,
  _requestId: string | undefined,
  _payload: Json,
): void {
  // In-memory diagnostics tracked via diagnostics module
}
