import type { ProviderModelConfig } from "../types/index.js";
import { API_ID } from "../types/index.js";

export const DEFAULT_BASE_URL = "https://anyrouter.top";

export const DEFAULT_MODELS: ProviderModelConfig[] = [
  {
    id: "gpt-6-astra",
    name: "GPT 6 Astra",
    api: API_ID,
    reasoning: true,
    input: ["text"],
    contextWindow: 1000000,
    maxTokens: 64000,
  },
  {
    id: "gpt-6-astra-cc-format",
    name: "GPT 6 Astra (CC Format)",
    api: API_ID,
    reasoning: true,
    input: ["text"],
    contextWindow: 1000000,
    maxTokens: 64000,
  },
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    api: API_ID,
    reasoning: true,
    input: ["text"],
    contextWindow: 1000000,
    maxTokens: 64000,
  },
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    api: API_ID,
    reasoning: true,
    input: ["text"],
    contextWindow: 500000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    api: API_ID,
    reasoning: true,
    input: ["text"],
    contextWindow: 500000,
    maxTokens: 32000,
  },
  {
    id: "claude-sonnet-4-5-20250929",
    name: "Claude Sonnet 4.5",
    api: API_ID,
    reasoning: true,
    input: ["text"],
    contextWindow: 500000,
    maxTokens: 32000,
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    api: API_ID,
    reasoning: true,
    input: ["text"],
    contextWindow: 200000,
    maxTokens: 32000,
  },
];
