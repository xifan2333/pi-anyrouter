import { AsyncLocalStorage } from "node:async_hooks";
import type { DiagnosticsSnapshot } from "../types/index.js";
import { redactSecrets } from "../utils/security.js";

const storage = new AsyncLocalStorage<DiagnosticsSnapshot>();

let lastSnapshot: DiagnosticsSnapshot = {};

function currentBag(): DiagnosticsSnapshot {
  return storage.getStore() ?? lastSnapshot;
}

export async function runWithDiagnostics<T>(fn: () => Promise<T>): Promise<T> {
  const bag: DiagnosticsSnapshot = {};
  return storage.run(bag, async () => {
    try {
      return await fn();
    } finally {
      lastSnapshot = { ...bag };
    }
  });
}

export function getLastDiagnostics(): Readonly<DiagnosticsSnapshot> {
  return lastSnapshot;
}

export function setDiagnosticsField<K extends keyof DiagnosticsSnapshot>(
  key: K,
  value: DiagnosticsSnapshot[K],
): void {
  currentBag()[key] = value;
}

export function recordDiagnosticsError(error: unknown): void {
  const msg = error instanceof Error ? error.message : String(error);
  setDiagnosticsField("error", redactSecrets(msg).slice(0, 1000));
}

export function resetDiagnostics(): void {
  lastSnapshot = {};
}
