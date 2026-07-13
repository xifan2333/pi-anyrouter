import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  calculateCost,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type Tool,
  type ToolResultMessage,
  type ImageContent,
} from "@earendil-works/pi-ai";

type Json = Record<string, any>;
type StreamMode = "off" | "auto" | "force";
type FetchInit = Parameters<typeof fetch>[1];

type ProviderModelConfig = {
  id: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  contextWindow?: number;
  maxTokens?: number;
};

type ProviderConfigFile = {
  baseUrl?: string;
  apiKey?: string;
  models?: ProviderModelConfig[];
};

const DEFAULT_CONFIG_PATH = join(homedir(), ".pi", "agent", "anyrouter-cc.json");
const CONFIG_PATH = process.env.PI_ANYROUTER_CC_CONFIG || DEFAULT_CONFIG_PATH;
const PROVIDER_NAME = "anyrouter-cc";
// Keep this API id unique so pi uses this extension's streamSimple handler
// without touching the built-in anthropic-messages implementation.
const API_ID = "anyrouter-cc-messages" as Api;
const DEBUG_ENABLED = process.env.PI_ANYROUTER_CC_DEBUG === "1";
const DEBUG_DIR = process.env.PI_ANYROUTER_CC_DEBUG_DIR || join(process.cwd(), ".pi", "anyrouter-cc-debug");
// Captured from the locally installed Claude Code on 2026-07-11.
const CLAUDE_CODE_VERSION = "2.1.206";
const CLAUDE_CODE_VERSION_BUILD = "2.1.206.3ee";
const STAINLESS_PACKAGE_VERSION = "0.94.0";
const STAINLESS_OS = "Linux";
const STAINLESS_ARCH = "x64";
const STAINLESS_RUNTIME = "node";
const STAINLESS_RUNTIME_VERSION = "v26.3.0";
const ANTHROPIC_BETA = "claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,effort-2025-11-24";
const CLAUDE_DEVICE_ID = randomBytes(32).toString("hex");
const CODEX_VERSION = "0.144.1";
const CODEX_INSTALLATION_ID = randomUUID();

const NAME_MAP: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  grep: "Grep",
  find: "Glob",
  glob: "Glob",
  ls: "LS",
  todowrite: "TodoWrite",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  google_search: "Google_Search",
};

function toClaudeCodeName(name?: string | null) {
  if (!name || typeof name !== "string") return name;
  return NAME_MAP[name.toLowerCase()] ?? name.charAt(0).toUpperCase() + name.slice(1);
}

function fromClaudeCodeName(name?: string | null) {
  if (!name || typeof name !== "string") return name;
  const lower = name.toLowerCase();
  for (const [from, to] of Object.entries(NAME_MAP)) {
    if (to.toLowerCase() === lower) return from;
  }
  return name.charAt(0).toLowerCase() + name.slice(1);
}

function sanitizeText(text: string) {
  return text.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

function resolveConfigValue(value?: string) {
  if (!value) return "";
  if (value.startsWith("!")) {
    throw new Error("anyrouter-cc does not support shell-command apiKey values. Use a literal key, env var name, or PI_ANYROUTER_CC_API_KEY.");
  }
  return process.env[value] || value;
}

function loadSourceProvider() {
  let content = "";
  try {
    content = readFileSync(CONFIG_PATH, "utf8");
  } catch {
    throw new Error(`Config file not found: ${CONFIG_PATH}. Create it from anyrouter-cc.example.json or set PI_ANYROUTER_CC_CONFIG.`);
  }

  let parsed: ProviderConfigFile;
  try {
    parsed = JSON.parse(content) as ProviderConfigFile;
  } catch (error) {
    throw new Error(`Invalid JSON in ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const baseUrl = process.env.PI_ANYROUTER_CC_BASE_URL || parsed.baseUrl;
  const apiKey = process.env.PI_ANYROUTER_CC_API_KEY || resolveConfigValue(parsed.apiKey);
  const models = parsed.models || [];

  if (!baseUrl) throw new Error(`Missing baseUrl in ${CONFIG_PATH}. You can also set PI_ANYROUTER_CC_BASE_URL.`);
  if (!apiKey) throw new Error(`Missing apiKey in ${CONFIG_PATH}. You can also set PI_ANYROUTER_CC_API_KEY.`);
  if (!models.length) throw new Error(`No models configured in ${CONFIG_PATH}. Add at least one model entry.`);

  return { baseUrl, apiKey, models };
}

function convertContentBlocks(content: (TextContent | ImageContent)[]) {
  const hasImages = content.some((c) => c.type === "image");
  if (!hasImages) return sanitizeText(content.map((c) => (c as TextContent).text).join("\n"));

  const blocks = content.map((block) => {
    if (block.type === "text") return { type: "text", text: sanitizeText(block.text) };
    return { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } };
  });
  if (!blocks.some((b) => b.type === "text")) blocks.unshift({ type: "text", text: "(see attached image)" });
  return blocks;
}

function convertMessages(messages: Message[]) {
  const params: any[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        const text = sanitizeText(msg.content);
        if (text.trim()) params.push({ role: "user", content: [{ type: "text", text }] });
      } else {
        const blocks = msg.content.map((item) =>
          item.type === "text"
            ? { type: "text", text: sanitizeText(item.text) }
            : { type: "image", source: { type: "base64", media_type: item.mimeType, data: item.data } },
        );
        if (blocks.length > 0) params.push({ role: "user", content: blocks });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const blocks: any[] = [];
      for (const block of msg.content) {
        if (block.type === "text" && block.text.trim()) blocks.push({ type: "text", text: sanitizeText(block.text) });
        else if (block.type === "thinking" && block.thinking.trim()) {
          if ((block as ThinkingContent).thinkingSignature) {
            blocks.push({ type: "thinking", thinking: sanitizeText(block.thinking), signature: (block as ThinkingContent).thinkingSignature });
          } else {
            blocks.push({ type: "text", text: sanitizeText(block.thinking) });
          }
        } else if (block.type === "toolCall") {
          blocks.push({ type: "tool_use", id: block.id, name: toClaudeCodeName(block.name), input: block.arguments });
        }
      }
      if (blocks.length > 0) params.push({ role: "assistant", content: blocks });
      continue;
    }

    if (msg.role === "toolResult") {
      const toolResults: any[] = [];
      const pushToolResult = (toolMsg: ToolResultMessage) => {
        toolResults.push({ type: "tool_result", tool_use_id: toolMsg.toolCallId, content: convertContentBlocks(toolMsg.content), is_error: toolMsg.isError });
      };
      pushToolResult(msg as ToolResultMessage);
      let j = i + 1;
      while (j < messages.length && messages[j].role === "toolResult") {
        pushToolResult(messages[j] as ToolResultMessage);
        j++;
      }
      i = j - 1;
      params.push({ role: "user", content: toolResults });
    }
  }

  if (params.length > 0) {
    const last = params[params.length - 1];
    if (last.role === "user" && Array.isArray(last.content) && last.content.length > 0) {
      last.content[last.content.length - 1].cache_control = { type: "ephemeral" };
    }
  }
  return params;
}

function convertTools(tools: Tool[]) {
  return tools.map((tool) => ({
    name: toClaudeCodeName(tool.name),
    description: tool.description,
    input_schema: {
      type: "object",
      properties: (tool.parameters as any).properties || {},
      required: (tool.parameters as any).required || [],
    },
  }));
}

function mapReasoningEffort(level?: SimpleStreamOptions["reasoning"]) {
  switch (level) {
    case "minimal":
    case "low": return "low";
    case "medium": return "medium";
    case "high": return "high";
    case "xhigh": return "xhigh";
    default: return "medium";
  }
}

function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case "end_turn":
    case "pause_turn":
    case "stop_sequence": return "stop";
    case "max_tokens": return "length";
    case "tool_use": return "toolUse";
    default: return "error";
  }
}

function getClaudeCodeHeaders(apiKey: string, retryCount = 0, sessionId: string) {
  return {
    "content-type": "application/json",
    accept: "application/json",
    authorization: `Bearer ${apiKey}`,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-beta": ANTHROPIC_BETA,
    "user-agent": `claude-cli/${CLAUDE_CODE_VERSION} (external, sdk-cli)`,
    "x-app": "cli",
    "x-claude-code-session-id": sessionId,
    "x-stainless-retry-count": String(retryCount),
    "x-stainless-timeout": "600",
    "x-stainless-lang": "js",
    "x-stainless-package-version": STAINLESS_PACKAGE_VERSION,
    "x-stainless-os": STAINLESS_OS,
    "x-stainless-arch": STAINLESS_ARCH,
    "x-stainless-runtime": STAINLESS_RUNTIME,
    "x-stainless-runtime-version": STAINLESS_RUNTIME_VERSION,
  };
}

function createClaudeCodeMetadata(sessionId: string) {
  return {
    user_id: JSON.stringify({
      device_id: CLAUDE_DEVICE_ID,
      account_uuid: "",
      session_id: sessionId,
    }),
  };
}

function createClaudeCodeSystem(systemPrompt: string) {
  return [
    { type: "text", text: `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION_BUILD}; cc_entrypoint=sdk-cli;` },
    { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", cache_control: { type: "ephemeral" } },
    { type: "text", text: sanitizeText(systemPrompt), cache_control: { type: "ephemeral" } },
  ];
}

function redactHeaders(headers: Record<string, string>) {
  const redacted = { ...headers };
  if (redacted.authorization) redacted.authorization = "Bearer ***";
  if (redacted["x-api-key"]) redacted["x-api-key"] = "***";
  return redacted;
}

const PROXY_AGENTS = new Map<string, ProxyAgent>();

function hostMatchesNoProxy(hostname: string, pattern: string) {
  const item = pattern.trim().toLowerCase();
  if (!item) return false;
  if (item === "*") return true;
  const host = hostname.toLowerCase();
  if (item.startsWith(".")) return host === item.slice(1) || host.endsWith(item);
  return host === item || host.endsWith(`.${item}`);
}

function getProxyUrl(url: string) {
  const parsed = new URL(url);
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || "";
  if (noProxy.split(",").some((item) => hostMatchesNoProxy(parsed.hostname, item))) return undefined;
  if (parsed.protocol === "https:") return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  return process.env.HTTP_PROXY || process.env.http_proxy;
}

function getProxyAgent(proxyUrl: string) {
  let agent = PROXY_AGENTS.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent(proxyUrl);
    PROXY_AGENTS.set(proxyUrl, agent);
  }
  return agent;
}

function fetchWithProxy(url: string, init: FetchInit) {
  const proxyUrl = getProxyUrl(url);
  if (!proxyUrl) return fetch(url, init);
  return undiciFetch(url, { ...init, dispatcher: getProxyAgent(proxyUrl) } as any) as unknown as Promise<Response>;
}

function writeDebugFile(kind: "request" | "response" | "error", modelId: string, requestId: string | undefined, payload: Json) {
  if (!DEBUG_ENABLED) return;
  mkdirSync(DEBUG_DIR, { recursive: true });
  const safeModel = modelId.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const safeRequestId = (requestId || "no-request-id").replace(/[^a-zA-Z0-9._-]+/g, "_");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(DEBUG_DIR, `${timestamp}-${safeModel}-${safeRequestId}-${kind}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number) {
  return [408, 409, 429, 500, 502, 503, 504, 520, 522, 524].includes(status);
}

function parseRetryAfterMs(value: string | null) {
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

function getRetryDelayMs(attempt: number, retryAfterMs?: number) {
  if (typeof retryAfterMs === "number") return Math.max(0, Math.min(retryAfterMs, 30_000));
  const base = Math.min(1000 * (2 ** attempt), 15_000);
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

function getStreamMode(): StreamMode {
  // AnyRouter's Claude Code subscription route is SSE-first. Keep the exact
  // transport by default instead of falling back to a generic JSON request.
  const value = String(process.env.PI_ANYROUTER_CC_STREAM_MODE || "force").trim().toLowerCase();
  if (["1", "true", "on", "auto"].includes(value)) return "auto";
  if (["force", "only"].includes(value)) return "force";
  return "off";
}

function createEmptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function tryParseJson(text: string) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return undefined;
  }
}

function extractRequestId(parsed: any, headers: Headers) {
  return parsed?.error?.message?.match(/request id:\s*([^\)]+)/i)?.[1]
    || headers.get("x-oneapi-request-id")
    || undefined;
}

function updateUsageFromAnthropic(output: AssistantMessage, usage: any, model: Model<Api>) {
  if (usage?.input_tokens != null) output.usage.input = usage.input_tokens;
  if (usage?.output_tokens != null) output.usage.output = usage.output_tokens;
  if (usage?.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
  if (usage?.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
  output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
  calculateCost(model, output.usage);
}

function resetOutputState(output: AssistantMessage) {
  output.content = [];
  output.usage = createEmptyUsage();
  output.stopReason = "stop";
  output.errorMessage = undefined;
  output.responseId = undefined;
}

function isCodexModel(modelId: string, configuredApi?: string) {
  if (configuredApi) return configuredApi === "openai-codex-responses";
  return /(?:^|[-_.])(gpt|codex)(?:[-_.]|$)/i.test(modelId) || /^o\d(?:[-_.]|$)/i.test(modelId);
}

function getCodexResponsesUrl(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/responses")) return normalized;
  if (normalized.endsWith("/v1")) return `${normalized}/responses`;
  return `${normalized}/v1/responses`;
}

function convertCodexMessages(context: Context) {
  const input: any[] = [];
  if (context.systemPrompt) {
    input.push({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: sanitizeText(context.systemPrompt) }],
    });
  }

  for (const msg of context.messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        if (msg.content.trim()) {
          input.push({ type: "message", role: "user", content: [{ type: "input_text", text: sanitizeText(msg.content) }] });
        }
      } else {
        const content = msg.content.map((item) => item.type === "text"
          ? { type: "input_text", text: sanitizeText(item.text) }
          : { type: "input_image", detail: "auto", image_url: `data:${item.mimeType};base64,${item.data}` });
        if (content.length) input.push({ type: "message", role: "user", content });
      }
      continue;
    }

    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "thinking" && block.thinkingSignature) {
          const reasoning = tryParseJson(block.thinkingSignature);
          if (reasoning) input.push(reasoning);
        } else if (block.type === "text" && block.text.trim()) {
          input.push({
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: sanitizeText(block.text), annotations: [] }],
          });
        } else if (block.type === "toolCall") {
          const [callId, itemId] = block.id.split("|");
          input.push({
            type: "function_call",
            ...(itemId ? { id: itemId } : {}),
            call_id: callId,
            name: block.name,
            arguments: JSON.stringify(block.arguments),
          });
        }
      }
      continue;
    }

    if (msg.role === "toolResult") {
      const toolMsg = msg as ToolResultMessage;
      const text = toolMsg.content.filter((item) => item.type === "text").map((item) => (item as TextContent).text).join("\n");
      const images = toolMsg.content.filter((item) => item.type === "image") as ImageContent[];
      const output = images.length
        ? [
            ...(text ? [{ type: "input_text", text: sanitizeText(text) }] : []),
            ...images.map((image) => ({ type: "input_image", detail: "auto", image_url: `data:${image.mimeType};base64,${image.data}` })),
          ]
        : sanitizeText(text || (images.length ? "(see attached image)" : "(no tool output)"));
      input.push({ type: "function_call_output", call_id: toolMsg.toolCallId.split("|")[0], output });
    }
  }
  return input;
}

function convertCodexTools(tools: Tool[]) {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  }));
}

function createCodexMetadata(sessionId: string, turnId: string) {
  const windowId = `${sessionId}:0`;
  const turnMetadata = JSON.stringify({
    installation_id: CODEX_INSTALLATION_ID,
    session_id: sessionId,
    thread_id: sessionId,
    turn_id: turnId,
    window_id: windowId,
    request_kind: "turn",
    thread_source: "user",
    turn_started_at_unix_ms: Date.now(),
  });
  return {
    windowId,
    turnMetadata,
    clientMetadata: {
      session_id: sessionId,
      thread_id: sessionId,
      turn_id: turnId,
      "x-codex-installation-id": CODEX_INSTALLATION_ID,
      "x-codex-window-id": windowId,
      "x-codex-turn-metadata": turnMetadata,
    },
  };
}

function createCodexHeaders(apiKey: string, sessionId: string, metadata: ReturnType<typeof createCodexMetadata>) {
  return {
    authorization: `Bearer ${apiKey}`,
    accept: "text/event-stream",
    "content-type": "application/json",
    originator: "codex_exec",
    "user-agent": `codex_exec/${CODEX_VERSION} (Linux; x86_64) (codex_exec; ${CODEX_VERSION})`,
    "x-openai-internal-codex-responses-lite": "true",
    "x-codex-beta-features": "remote_compaction_v2",
    "x-codex-window-id": metadata.windowId,
    "x-codex-turn-metadata": metadata.turnMetadata,
    "x-client-request-id": sessionId,
    "session-id": sessionId,
    "thread-id": sessionId,
  };
}

function buildCodexRequestBody(model: Model<Api>, context: Context, options: SimpleStreamOptions | undefined, sessionId: string, metadata: ReturnType<typeof createCodexMetadata>) {
  const body: Json = {
    model: model.id,
    input: convertCodexMessages(context),
    tool_choice: "auto",
    parallel_tool_calls: false,
    reasoning: {
      effort: mapReasoningEffort(options?.reasoning),
      context: "all_turns",
    },
    store: false,
    stream: true,
    text: { verbosity: "low" },
    max_output_tokens: options?.maxTokens || model.maxTokens,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: sessionId,
    client_metadata: metadata.clientMetadata,
  };
  if (context.tools?.length) body.tools = convertCodexTools(context.tools);
  return body;
}

function applyCodexUsage(output: AssistantMessage, response: any, model: Model<Api>) {
  const usage = response?.usage;
  if (!usage) return;
  const cached = usage.input_tokens_details?.cached_tokens || 0;
  const cacheWrite = usage.input_tokens_details?.cache_write_tokens || 0;
  output.usage.input = Math.max(0, (usage.input_tokens || 0) - cached - cacheWrite);
  output.usage.output = usage.output_tokens || 0;
  output.usage.cacheRead = cached;
  output.usage.cacheWrite = cacheWrite;
  output.usage.totalTokens = usage.total_tokens || output.usage.input + output.usage.output + cached + cacheWrite;
  calculateCost(model, output.usage);
}

function applyCodexSsePayload(payload: any, output: AssistantMessage, stream: AssistantMessageEventStream, model: Model<Api>, slots: Map<number, any>) {
  const type = payload?.type;
  if (!type || type === "response.in_progress" || type === "response.metadata") return;
  if (type === "error") throw new Error(payload.message || JSON.stringify(payload));
  if (type === "response.failed") throw new Error(payload.response?.error?.message || "Codex response failed");

  if (type === "response.created") {
    output.responseId = payload.response?.id || output.responseId;
    return;
  }

  if (type === "response.output_item.added") {
    const item = payload.item;
    if (item?.type === "message") {
      const block = { type: "text", text: "" };
      output.content.push(block as any);
      const contentIndex = output.content.length - 1;
      slots.set(payload.output_index, { type: "text", block, contentIndex });
      stream.push({ type: "text_start", contentIndex, partial: output });
    } else if (item?.type === "reasoning") {
      const block = { type: "thinking", thinking: "", thinkingSignature: "" };
      output.content.push(block as any);
      const contentIndex = output.content.length - 1;
      slots.set(payload.output_index, { type: "thinking", block, contentIndex });
      stream.push({ type: "thinking_start", contentIndex, partial: output });
    } else if (item?.type === "function_call") {
      const block = { type: "toolCall", id: `${item.call_id}|${item.id}`, name: item.name, arguments: {}, partialJson: item.arguments || "" };
      output.content.push(block as any);
      const contentIndex = output.content.length - 1;
      slots.set(payload.output_index, { type: "toolCall", block, contentIndex });
      stream.push({ type: "toolcall_start", contentIndex, partial: output });
    }
    return;
  }

  const slot = slots.get(payload.output_index);
  if (type === "response.output_text.delta" && slot?.type === "text") {
    slot.block.text += String(payload.delta || "");
    stream.push({ type: "text_delta", contentIndex: slot.contentIndex, delta: String(payload.delta || ""), partial: output });
  } else if ((type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") && slot?.type === "thinking") {
    slot.block.thinking += String(payload.delta || "");
    stream.push({ type: "thinking_delta", contentIndex: slot.contentIndex, delta: String(payload.delta || ""), partial: output });
  } else if (type === "response.function_call_arguments.delta" && slot?.type === "toolCall") {
    slot.block.partialJson += String(payload.delta || "");
    const parsed = tryParseJson(slot.block.partialJson);
    if (parsed !== undefined) slot.block.arguments = parsed;
    stream.push({ type: "toolcall_delta", contentIndex: slot.contentIndex, delta: String(payload.delta || ""), partial: output });
  } else if (type === "response.function_call_arguments.done" && slot?.type === "toolCall") {
    slot.block.partialJson = String(payload.arguments || slot.block.partialJson);
    slot.block.arguments = tryParseJson(slot.block.partialJson) || {};
  } else if (type === "response.output_item.done") {
    const item = payload.item;
    if (slot?.type === "text" && item?.type === "message") {
      slot.block.text = item.content?.map((part: any) => part.text || part.refusal || "").join("") || slot.block.text;
      stream.push({ type: "text_end", contentIndex: slot.contentIndex, content: slot.block.text, partial: output });
    } else if (slot?.type === "thinking" && item?.type === "reasoning") {
      slot.block.thinking = item.summary?.map((part: any) => part.text).join("\n\n") || item.content?.map((part: any) => part.text).join("\n\n") || slot.block.thinking;
      slot.block.thinkingSignature = JSON.stringify(item);
      stream.push({ type: "thinking_end", contentIndex: slot.contentIndex, content: slot.block.thinking, partial: output });
    } else if (slot?.type === "toolCall" && item?.type === "function_call") {
      slot.block.arguments = tryParseJson(item.arguments || slot.block.partialJson) || {};
      delete slot.block.partialJson;
      stream.push({ type: "toolcall_end", contentIndex: slot.contentIndex, toolCall: slot.block, partial: output });
    }
    slots.delete(payload.output_index);
  } else if (type === "response.completed" || type === "response.incomplete") {
    output.responseId = payload.response?.id || output.responseId;
    applyCodexUsage(output, payload.response, model);
    output.stopReason = type === "response.incomplete" ? "length" : output.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
  }
}

async function tryStreamAnyRouterCodex(url: string, body: Json, apiKey: string, model: Model<Api>, output: AssistantMessage, stream: AssistantMessageEventStream, sessionId: string, metadata: ReturnType<typeof createCodexMetadata>, signal?: AbortSignal) {
  const bodyText = JSON.stringify(body);
  const maxRetries = Math.max(0, Number(process.env.PI_ANYROUTER_CC_MAX_RETRIES || "10") || 0);
  let response: Response | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const headers = createCodexHeaders(apiKey, sessionId, metadata);
    if (attempt === 0) writeDebugFile("request", model.id, undefined, { url, headers: redactHeaders(headers), body, transport: "codex-sse" });
    try {
      response = await fetchWithProxy(url, { method: "POST", signal, headers, body: bodyText });
    } catch (error) {
      if (attempt < maxRetries && !signal?.aborted) {
        await delay(getRetryDelayMs(attempt));
        continue;
      }
      throw error;
    }

    if (response.ok && (response.headers.get("content-type") || "").includes("text/event-stream")) break;
    const raw = await response.text();
    const parsed = tryParseJson(raw) || { raw };
    const requestId = extractRequestId(parsed, response.headers);
    writeDebugFile("error", model.id, requestId, { status: response.status, requestId, body: parsed, raw, transport: "codex-sse", retryAttempt: attempt });
    if (!response.ok && attempt < maxRetries && isRetryableStatus(response.status)) {
      await delay(getRetryDelayMs(attempt, parseRetryAfterMs(response.headers.get("retry-after"))));
      response = undefined;
      continue;
    }
    throw new Error(raw || `HTTP ${response.status}`);
  }

  if (!response?.body) throw new Error("Codex stream response body missing");
  const slots = new Map<number, any>();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let parsedChunk = nextSseChunk(buffer);
    while (parsedChunk) {
      buffer = parsedChunk.rest;
      const event = parseSseEvent(parsedChunk.chunk);
      if (event.data && event.data !== "[DONE]") {
        const payload = tryParseJson(event.data);
        if (!payload) throw new Error(`invalid Codex SSE payload: ${event.data.slice(0, 200)}`);
        applyCodexSsePayload(payload, output, stream, model, slots);
        if (payload.type === "response.completed" || payload.type === "response.incomplete") terminal = true;
      }
      parsedChunk = nextSseChunk(buffer);
    }
    if (done) break;
  }
  const tail = buffer.trim();
  if (tail) {
    const event = parseSseEvent(tail);
    if (event.data && event.data !== "[DONE]") {
      const payload = tryParseJson(event.data);
      if (!payload) throw new Error(`invalid Codex SSE payload: ${event.data.slice(0, 200)}`);
      applyCodexSsePayload(payload, output, stream, model, slots);
      if (payload.type === "response.completed" || payload.type === "response.incomplete") terminal = true;
    }
  }
  if (!terminal) throw new Error("Codex stream ended before a terminal response event");
  writeDebugFile("response", model.id, response.headers.get("x-oneapi-request-id") || undefined, {
    status: response.status,
    responseId: output.responseId,
    stopReason: output.stopReason,
    usage: output.usage,
    transport: "codex-sse",
  });
}

function applyJsonResponseToOutput(response: any, output: AssistantMessage, stream: AssistantMessageEventStream, model: Model<Api>) {
  updateUsageFromAnthropic(output, response?.usage || {}, model);
  output.stopReason = mapStopReason(response?.stop_reason || "end_turn");

  const content = Array.isArray(response?.content) ? response.content : [];
  for (const block of content) {
    if (block?.type === "text") {
      output.content.push({ type: "text", text: "" });
      const contentIndex = output.content.length - 1;
      stream.push({ type: "text_start", contentIndex, partial: output });
      const text = String(block.text || "");
      (output.content[contentIndex] as any).text = text;
      if (text) stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
      stream.push({ type: "text_end", contentIndex, content: text, partial: output });
    } else if (block?.type === "thinking") {
      output.content.push({ type: "thinking", thinking: String(block.thinking || ""), thinkingSignature: block.signature || "" } as any);
      const contentIndex = output.content.length - 1;
      stream.push({ type: "thinking_start", contentIndex, partial: output });
      if (block.thinking) stream.push({ type: "thinking_delta", contentIndex, delta: String(block.thinking), partial: output });
      stream.push({ type: "thinking_end", contentIndex, content: String(block.thinking || ""), partial: output });
    } else if (block?.type === "tool_use") {
      const toolCall = { type: "toolCall" as const, id: block.id, name: fromClaudeCodeName(block.name), arguments: block.input || {} };
      output.content.push(toolCall as any);
      const contentIndex = output.content.length - 1;
      stream.push({ type: "toolcall_start", contentIndex, partial: output });
      stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(toolCall.arguments), partial: output });
      stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
    }
  }
}

function parseSseEvent(chunk: string) {
  let event = "message";
  const data: string[] = [];
  for (const line of chunk.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return { event, data: data.join("\n") };
}

function nextSseChunk(buffer: string) {
  const unix = buffer.indexOf("\n\n");
  const dos = buffer.indexOf("\r\n\r\n");
  if (unix === -1 && dos === -1) return undefined;
  if (dos !== -1 && (unix === -1 || dos < unix)) {
    return { chunk: buffer.slice(0, dos), rest: buffer.slice(dos + 4) };
  }
  return { chunk: buffer.slice(0, unix), rest: buffer.slice(unix + 2) };
}

function applySsePayloadEvent(payload: any, output: AssistantMessage, stream: AssistantMessageEventStream, model: Model<Api>, blockIndexByEventIndex: Map<number, number>) {
  if (!payload?.type || payload.type === "ping" || payload.type === "message_stop") return;

  if (payload.type === "error") {
    const errorText = payload?.error?.message || payload?.error || payload?.message || JSON.stringify(payload);
    throw new Error(String(errorText));
  }

  if (payload.type === "message_start") {
    output.responseId = payload.message?.id || output.responseId;
    updateUsageFromAnthropic(output, payload.message?.usage || {}, model);
    return;
  }

  if (payload.type === "content_block_start") {
    const block = payload.content_block;
    if (block?.type === "text") {
      output.content.push({ type: "text", text: "", eventIndex: payload.index } as any);
      const contentIndex = output.content.length - 1;
      blockIndexByEventIndex.set(payload.index, contentIndex);
      stream.push({ type: "text_start", contentIndex, partial: output });
      return;
    }
    if (block?.type === "thinking" || block?.type === "redacted_thinking") {
      output.content.push({
        type: "thinking",
        thinking: block.type === "redacted_thinking" ? "[Reasoning redacted]" : "",
        thinkingSignature: block.type === "redacted_thinking" ? String(block.data || "") : "",
        redacted: block.type === "redacted_thinking" ? true : undefined,
        eventIndex: payload.index,
      } as any);
      const contentIndex = output.content.length - 1;
      blockIndexByEventIndex.set(payload.index, contentIndex);
      stream.push({ type: "thinking_start", contentIndex, partial: output });
      return;
    }
    if (block?.type === "tool_use") {
      const toolCall = {
        type: "toolCall" as const,
        id: block.id,
        name: fromClaudeCodeName(block.name),
        arguments: (block.input as Json) || {},
        partialJson: "",
        eventIndex: payload.index,
      };
      output.content.push(toolCall as any);
      const contentIndex = output.content.length - 1;
      blockIndexByEventIndex.set(payload.index, contentIndex);
      stream.push({ type: "toolcall_start", contentIndex, partial: output });
    }
    return;
  }

  if (payload.type === "content_block_delta") {
    const contentIndex = blockIndexByEventIndex.get(payload.index);
    if (contentIndex == null) return;
    const block = output.content[contentIndex] as any;
    if (!block) return;

    if (payload.delta?.type === "text_delta" && block.type === "text") {
      block.text += String(payload.delta.text || "");
      stream.push({ type: "text_delta", contentIndex, delta: String(payload.delta.text || ""), partial: output });
      return;
    }
    if (payload.delta?.type === "thinking_delta" && block.type === "thinking") {
      block.thinking += String(payload.delta.thinking || "");
      stream.push({ type: "thinking_delta", contentIndex, delta: String(payload.delta.thinking || ""), partial: output });
      return;
    }
    if (payload.delta?.type === "input_json_delta" && block.type === "toolCall") {
      block.partialJson += String(payload.delta.partial_json || "");
      try {
        block.arguments = JSON.parse(block.partialJson);
      } catch {
        // partial json is expected during streaming
      }
      stream.push({ type: "toolcall_delta", contentIndex, delta: String(payload.delta.partial_json || ""), partial: output });
      return;
    }
    if (payload.delta?.type === "signature_delta" && block.type === "thinking") {
      block.thinkingSignature = `${block.thinkingSignature || ""}${String(payload.delta.signature || "")}`;
    }
    return;
  }

  if (payload.type === "content_block_stop") {
    const contentIndex = blockIndexByEventIndex.get(payload.index);
    if (contentIndex == null) return;
    const block = output.content[contentIndex] as any;
    if (!block) return;

    delete block.eventIndex;
    blockIndexByEventIndex.delete(payload.index);

    if (block.type === "text") {
      stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
      return;
    }
    if (block.type === "thinking") {
      stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
      return;
    }
    if (block.type === "toolCall") {
      if (block.partialJson) {
        try {
          block.arguments = JSON.parse(block.partialJson);
        } catch {
          block.arguments = block.arguments || {};
        }
      }
      delete block.partialJson;
      stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
    }
    return;
  }

  if (payload.type === "message_delta") {
    if (payload.delta?.stop_reason) output.stopReason = mapStopReason(payload.delta.stop_reason);
    updateUsageFromAnthropic(output, payload.usage || {}, model);
  }
}

async function tryStreamAnyRouterCc(url: string, body: Json, apiKey: string, model: Model<Api>, output: AssistantMessage, stream: AssistantMessageEventStream, sessionId: string, signal?: AbortSignal) {
  const requestBody = { ...body, stream: true };
  const bodyText = JSON.stringify(requestBody);
  const maxRetries = Math.max(0, Number(process.env.PI_ANYROUTER_CC_MAX_RETRIES || "10") || 0);
  let response: Response | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Real Claude Code keeps this at zero across its application-level retries.
    const headers = getClaudeCodeHeaders(apiKey, 0, sessionId);
    if (attempt === 0) {
      writeDebugFile("request", model.id, undefined, {
        url,
        headers: redactHeaders(headers),
        body: requestBody,
        transport: "sse",
      });
    }

    try {
      response = await fetchWithProxy(url, {
        method: "POST",
        signal,
        headers,
        body: bodyText,
      });
    } catch (error) {
      if (attempt < maxRetries && !signal?.aborted) {
        await delay(getRetryDelayMs(attempt));
        continue;
      }
      throw error;
    }

    const contentType = response.headers.get("content-type") || "";
    if (response.ok && contentType.includes("text/event-stream")) break;

    const raw = await response.text();
    const parsed = tryParseJson(raw) || { raw };
    const requestId = extractRequestId(parsed, response.headers);
    writeDebugFile(response.ok ? "response" : "error", model.id, requestId, {
      status: response.status,
      statusText: response.statusText,
      requestId,
      headers: Object.fromEntries(response.headers.entries()),
      body: parsed,
      raw,
      transport: "sse",
      retryAttempt: attempt,
      maxRetries,
    });

    if (!response.ok && attempt < maxRetries && isRetryableStatus(response.status)) {
      // Push visible retry feedback so pi's UI shows activity instead of a frozen "working" status.
      const retryBlockIndex = output.content.length;
      const retryText = `⏳ ${response.status} — retrying (${attempt + 1}/${maxRetries})…`;
      output.content.push({ type: "text", text: retryText } as any);
      stream.push({ type: "text_start", contentIndex: retryBlockIndex, partial: output });
      stream.push({ type: "text_delta", contentIndex: retryBlockIndex, delta: retryText, partial: output });
      stream.push({ type: "text_end", contentIndex: retryBlockIndex, content: retryText, partial: output });
      await delay(getRetryDelayMs(attempt, parseRetryAfterMs(response.headers.get("retry-after"))));
      response = undefined;
      continue;
    }
    if (response.ok) throw new Error(`stream response was not SSE (content-type=${contentType || "<missing>"})`);
    throw new Error(raw || `HTTP ${response.status}`);
  }

  if (!response?.body) throw new Error("stream response body missing");

  const blockIndexByEventIndex = new Map<number, number>();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    let parsedChunk = nextSseChunk(buffer);
    while (parsedChunk) {
      buffer = parsedChunk.rest;
      const event = parseSseEvent(parsedChunk.chunk);
      if (event.data) {
        const payload = tryParseJson(event.data);
        if (!payload && event.data !== "[DONE]") throw new Error(`invalid SSE payload: ${event.data.slice(0, 200)}`);
        if (payload) applySsePayloadEvent(payload, output, stream, model, blockIndexByEventIndex);
      }
      parsedChunk = nextSseChunk(buffer);
    }

    if (done) break;
  }

  const tail = buffer.trim();
  if (tail) {
    const event = parseSseEvent(tail);
    if (event.data && event.data !== "[DONE]") {
      const payload = tryParseJson(event.data);
      if (!payload) throw new Error(`invalid SSE payload: ${event.data.slice(0, 200)}`);
      applySsePayloadEvent(payload, output, stream, model, blockIndexByEventIndex);
    }
  }

  writeDebugFile("response", model.id, response.headers.get("x-oneapi-request-id") || undefined, {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    body: {
      responseId: output.responseId,
      stopReason: output.stopReason,
      usage: output.usage,
      contentBlocks: output.content.length,
    },
    transport: "sse",
  });
}

async function postJson(url: string, body: Json, apiKey: string, modelId: string, sessionId: string, signal?: AbortSignal) {
  const maxRetries = Math.max(0, Number(process.env.PI_ANYROUTER_CC_MAX_RETRIES || "10") || 0);
  const bodyText = JSON.stringify(body);
  let lastErrorText = "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const headers = getClaudeCodeHeaders(apiKey, attempt, sessionId);
    if (attempt === 0) {
      writeDebugFile("request", modelId, undefined, {
        url,
        headers: redactHeaders(headers),
        body,
      });
    }

    let response: Response;
    try {
      response = await fetchWithProxy(url, {
        method: "POST",
        signal,
        headers,
        body: bodyText,
      });
    } catch (error) {
      if (attempt < maxRetries) {
        await delay(getRetryDelayMs(attempt));
        continue;
      }
      throw error;
    }

    const text = await response.text();
    lastErrorText = text;
    let parsed: any = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    const requestId = parsed?.error?.message?.match(/request id:\s*([^\)]+)/i)?.[1]
      || response.headers.get("x-oneapi-request-id")
      || undefined;

    writeDebugFile(response.ok ? "response" : "error", modelId, requestId, {
      status: response.status,
      statusText: response.statusText,
      requestId,
      headers: Object.fromEntries(response.headers.entries()),
      body: parsed,
      raw: text,
      retryAttempt: attempt,
      maxRetries,
    });

    if (response.ok) return parsed;
    if (attempt < maxRetries && isRetryableStatus(response.status)) {
      await delay(getRetryDelayMs(attempt, parseRetryAfterMs(response.headers.get("retry-after"))));
      continue;
    }
    throw new Error(text || `HTTP ${response.status}`);
  }

  throw new Error(lastErrorText || "HTTP request failed after retries");
}

function streamAnyRouterCc(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: createEmptyUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      const source = loadSourceProvider();
      const sessionId = randomUUID();

      const configuredModel = source.models.find((item) => item.id === model.id);
      if (isCodexModel(model.id, configuredModel?.api)) {
        const turnId = randomUUID();
        const metadata = createCodexMetadata(sessionId, turnId);
        const codexBody = buildCodexRequestBody(model, context, options, sessionId, metadata);
        stream.push({ type: "start", partial: output });
        await tryStreamAnyRouterCodex(
          getCodexResponsesUrl(source.baseUrl),
          codexBody,
          source.apiKey,
          model,
          output,
          stream,
          sessionId,
          metadata,
          options?.signal,
        );
        if (options?.signal?.aborted) throw new Error("Request was aborted");
        stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
        stream.end();
        return;
      }

      const url = `${source.baseUrl.replace(/\/$/, "")}/v1/messages?beta=true`;
      const requestBody: Json = {
        model: model.id,
        messages: convertMessages(context.messages),
        max_tokens: options?.maxTokens || model.maxTokens || 32000,
        stream: false,
        metadata: createClaudeCodeMetadata(sessionId),
        system: createClaudeCodeSystem(context.systemPrompt || "You are an expert coding assistant operating inside pi."),
        context_management: {
          edits: [{ type: "clear_thinking_20251015", keep: "all" }],
        },
      };
      if (context.tools?.length) requestBody.tools = convertTools(context.tools);
      if (options?.reasoning && model.reasoning) {
        requestBody.thinking = { type: "adaptive", display: "omitted" };
        requestBody.output_config = { effort: mapReasoningEffort(options.reasoning) };
      }

      stream.push({ type: "start", partial: output });

      const streamMode = getStreamMode();
      if (streamMode !== "off") {
        try {
          await tryStreamAnyRouterCc(url, requestBody, source.apiKey, model, output, stream, sessionId, options?.signal);
          if (options?.signal?.aborted) throw new Error("Request was aborted");
          stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
          stream.end();
          return;
        } catch (streamError) {
          if (streamMode === "force" || output.content.length > 0) {
            // All retries exhausted. Push a text block with the error so pi
            // shows it, then end with done/stop to prevent pi from auto-retrying
            // the entire provider stream.
            const errText = `[anyrouter-cc] ${streamError instanceof Error ? streamError.message : String(streamError)}`;
            const contentIndex = output.content.length;
            output.content.push({ type: "text", text: errText } as any);
            output.stopReason = "stop";
            output.errorMessage = errText;
            stream.push({ type: "text_start", contentIndex, partial: output });
            stream.push({ type: "text_delta", contentIndex, delta: errText, partial: output });
            stream.push({ type: "text_end", contentIndex, content: errText, partial: output });
            stream.push({ type: "done", reason: "stop", message: output });
            stream.end();
            return;
          }
          writeDebugFile("error", model.id, undefined, {
            phase: "stream-fallback",
            errorMessage: streamError instanceof Error ? streamError.message : String(streamError),
          });
          resetOutputState(output);
        }
      }

      const response = await postJson(url, requestBody, source.apiKey, model.id, sessionId, options?.signal);
      applyJsonResponseToOutput(response, output, stream, model);
      stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? `[anyrouter-cc] ${error.message}` : String(error);
      writeDebugFile("error", model.id, undefined, {
        stopReason: output.stopReason,
        errorMessage: output.errorMessage,
      });
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

export default function (pi: ExtensionAPI) {
  try {
    const source = loadSourceProvider();
    pi.registerProvider(PROVIDER_NAME, {
      baseUrl: source.baseUrl,
      apiKey: source.apiKey,
      api: API_ID,
      models: source.models.map((model) => ({
        id: model.id,
        name: model.name ? `${model.name} (AnyRouter CC)` : `${model.id} (AnyRouter CC)`,
        api: API_ID,
        reasoning: model.reasoning ?? true,
        input: model.input ?? ["text"],
        cost: {
          input: model.cost?.input ?? 0,
          output: model.cost?.output ?? 0,
          cacheRead: model.cost?.cacheRead ?? 0,
          cacheWrite: model.cost?.cacheWrite ?? 0,
        },
        contextWindow: model.contextWindow ?? 200000,
        maxTokens: model.maxTokens ?? 32000,
      })),
      streamSimple: streamAnyRouterCc,
    });
  } catch (error) {
    console.error(`[anyrouter-cc] Failed to register provider: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`[anyrouter-cc] Config path: ${CONFIG_PATH}`);
    console.error(`[anyrouter-cc] You can override with PI_ANYROUTER_CC_CONFIG, PI_ANYROUTER_CC_BASE_URL, PI_ANYROUTER_CC_API_KEY`);
  }
}
