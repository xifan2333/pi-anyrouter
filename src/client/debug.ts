import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Json } from "../types/index.js";

const DEBUG_ENABLED = process.env.PI_ANYROUTER_CC_DEBUG === "1";
const DEBUG_DIR =
  process.env.PI_ANYROUTER_CC_DEBUG_DIR || join(process.cwd(), ".pi", "anyrouter-cc-debug");

export function isDebugEnabled(): boolean {
  return DEBUG_ENABLED;
}

export function writeDebugFile(
  kind: "request" | "response" | "error",
  modelId: string,
  requestId: string | undefined,
  payload: Json,
): void {
  if (!DEBUG_ENABLED) return;
  try {
    mkdirSync(DEBUG_DIR, { recursive: true });
    const safeModel = modelId.replace(/[^a-zA-Z0-9._-]+/g, "_");
    const safeRequestId = (requestId || "no-request-id").replace(/[^a-zA-Z0-9._-]+/g, "_");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(DEBUG_DIR, `${timestamp}-${safeModel}-${safeRequestId}-${kind}.json`);
    writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    // Best-effort debug file logging
  }
}
