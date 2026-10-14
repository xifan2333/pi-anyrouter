import type { Api } from "@earendil-works/pi-ai";

export type Json = Record<string, any>;
export type StreamMode = "off" | "auto" | "force";

export type ProviderModelConfig = {
  id: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  contextWindow?: number;
  maxTokens?: number;
};

export type ProviderConfigFile = {
  baseUrl?: string;
  apiKey?: string;
  models?: ProviderModelConfig[];
};

export type AnyRouterConfig = {
  baseUrl: string;
  apiKey: string;
  models: ProviderModelConfig[];
  configPath: string;
};

export type DiagnosticsSnapshot = {
  status?: number;
  endpoint?: string;
  modelId?: string;
  protocol?: "claude-code" | "codex-responses";
  toolsInjected?: string[];
  systemPromptLength?: number;
  error?: string;
  requestId?: string;
  latencyMs?: number;
  retryAttempt?: number;
};

export const PROVIDER_NAME = "anyrouter";
export const PROVIDER_ID = "anyrouter";
export const API_ID = "anyrouter-messages" as Api;

export const CLAUDE_CODE_VERSION = "2.1.206";
export const CLAUDE_CODE_VERSION_BUILD = "2.1.206.3ee";
export const STAINLESS_PACKAGE_VERSION = "0.94.0";
export const STAINLESS_OS = "Linux";
export const STAINLESS_ARCH = "x64";
export const STAINLESS_RUNTIME = "node";
export const STAINLESS_RUNTIME_VERSION = "v26.3.0";
export const ANTHROPIC_BETA =
  "claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,effort-2025-11-24";

export const CODEX_VERSION = "0.144.1";
