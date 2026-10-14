import { randomUUID } from "node:crypto";
import {
  calculateCost,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type Tool,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { CODEX_VERSION, type Json } from "../types/index.js";
import {
  iterateSseEvents,
  sanitizeText,
  tryParseJson,
} from "../utils/index.js";
import { postSseWithRetry } from "../client/index.js";
import { setDiagnosticsField } from "../diagnostics/index.js";
import { mapReasoningEffort } from "./claude.js";
import { resolveCurrentSystemPrompt, resolveCurrentTools } from "./context.js";

const CODEX_INSTALLATION_ID = randomUUID();

export function isCodexModel(modelId: string, configuredApi?: string): boolean {
  if (configuredApi === "openai-codex-responses") return true;
  if (configuredApi && configuredApi !== "anyrouter-messages") return false;
  return /(?:^|[-_.])(gpt|codex)(?:[-_.]|$)/i.test(modelId) || /^o\d(?:[-_.]|$)/i.test(modelId);
}

export function getCodexResponsesUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/responses")) return normalized;
  if (normalized.endsWith("/v1")) return `${normalized}/responses`;
  return `${normalized}/v1/responses`;
}

function convertCodexUserMessage(msg: any): any | undefined {
  if (typeof msg.content === "string") {
    const text = sanitizeText(msg.content);
    return text.trim()
      ? { type: "message", role: "user", content: [{ type: "input_text", text }] }
      : undefined;
  }
  const content = msg.content.map((item: any) =>
    item.type === "text"
      ? { type: "input_text", text: sanitizeText(item.text) }
      : {
          type: "input_image",
          detail: "auto",
          image_url: `data:${item.mimeType};base64,${item.data}`,
        },
  );
  return content.length ? { type: "message", role: "user", content } : undefined;
}

function convertCodexAssistantBlock(block: any): any | undefined {
  if (block.type === "thinking" && block.thinkingSignature) {
    return tryParseJson(block.thinkingSignature);
  }
  if (block.type === "text" && block.text.trim()) {
    return {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: sanitizeText(block.text), annotations: [] }],
    };
  }
  if (block.type === "toolCall") {
    const [callId, itemId] = block.id.split("|");
    return {
      type: "function_call",
      ...(itemId ? { id: itemId } : {}),
      call_id: callId,
      name: block.name,
      arguments: JSON.stringify(block.arguments),
    };
  }
  return undefined;
}

function convertCodexToolResult(msg: ToolResultMessage): any {
  const text = msg.content
    .filter((item) => item.type === "text")
    .map((item) => (item as TextContent).text)
    .join("\n");
  const images = msg.content.filter((item) => item.type === "image") as ImageContent[];
  const output = images.length
    ? [
        ...(text ? [{ type: "input_text", text: sanitizeText(text) }] : []),
        ...images.map((image) => ({
          type: "input_image",
          detail: "auto",
          image_url: `data:${image.mimeType};base64,${image.data}`,
        })),
      ]
    : sanitizeText(text || (images.length ? "(see attached image)" : "(no tool output)"));

  return {
    type: "function_call_output",
    call_id: msg.toolCallId.split("|")[0],
    output,
  };
}

export function convertCodexMessages(context: Context, systemPrompt?: string): any[] {
  const input: any[] = [];
  if (systemPrompt && systemPrompt.trim()) {
    input.push({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: sanitizeText(systemPrompt) }],
    });
  }

  for (const msg of context.messages) {
    if (msg.role === "user") {
      const converted = convertCodexUserMessage(msg);
      if (converted) input.push(converted);
      continue;
    }

    if (msg.role === "assistant") {
      for (const block of msg.content) {
        const converted = convertCodexAssistantBlock(block);
        if (converted) input.push(converted);
      }
      continue;
    }

    if (msg.role === "toolResult") {
      input.push(convertCodexToolResult(msg as ToolResultMessage));
    }
  }
  return input;
}

export function convertCodexTools(tools: Tool[]): any[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  }));
}

export function createCodexMetadata(sessionId: string, turnId: string) {
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

export function createCodexHeaders(
  apiKey: string,
  sessionId: string,
  metadata: ReturnType<typeof createCodexMetadata>,
): Record<string, string> {
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

export function buildCodexRequestBody(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  sessionId: string,
  metadata: ReturnType<typeof createCodexMetadata>,
): { body: Json; tools: Tool[]; systemPrompt: string } {
  const tools = resolveCurrentTools(context);
  const systemPrompt = resolveCurrentSystemPrompt(context);

  setDiagnosticsField("toolsInjected", tools.map((t) => t.name));
  setDiagnosticsField("systemPromptLength", systemPrompt.length);

  const body: Json = {
    model: model.id,
    input: convertCodexMessages(context, systemPrompt),
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

  if (tools.length > 0) {
    body.tools = convertCodexTools(tools);
  }

  return { body, tools, systemPrompt };
}

export function applyCodexUsage(output: AssistantMessage, response: any, model: Model<Api>): void {
  const usage = response?.usage;
  if (!usage) return;
  const cached = usage.input_tokens_details?.cached_tokens || 0;
  const cacheWrite = usage.input_tokens_details?.cache_write_tokens || 0;
  output.usage.input = Math.max(0, (usage.input_tokens || 0) - cached - cacheWrite);
  output.usage.output = usage.output_tokens || 0;
  output.usage.cacheRead = cached;
  output.usage.cacheWrite = cacheWrite;
  output.usage.totalTokens =
    usage.total_tokens || output.usage.input + output.usage.output + cached + cacheWrite;
  calculateCost(model, output.usage);
}

function handleCodexItemAdded(
  payload: any,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  slots: Map<number, any>,
): void {
  const item = payload.item;
  if (!item?.type) return;

  const contentIndex = output.content.length;

  if (item.type === "message") {
    const block = { type: "text" as const, text: "" };
    output.content.push(block as any);
    slots.set(payload.output_index, { type: "text", block, contentIndex });
    stream.push({ type: "text_start", contentIndex, partial: output });
    return;
  }

  if (item.type === "reasoning") {
    const block = { type: "thinking" as const, thinking: "", thinkingSignature: "" };
    output.content.push(block as any);
    slots.set(payload.output_index, { type: "thinking", block, contentIndex });
    stream.push({ type: "thinking_start", contentIndex, partial: output });
    return;
  }

  if (item.type === "function_call") {
    const block = {
      type: "toolCall" as const,
      id: `${item.call_id}|${item.id}`,
      name: item.name,
      arguments: {},
      partialJson: item.arguments || "",
    };
    output.content.push(block as any);
    slots.set(payload.output_index, { type: "toolCall", block, contentIndex });
    stream.push({ type: "toolcall_start", contentIndex, partial: output });
  }
}

function handleCodexDelta(
  type: string,
  payload: any,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  slot: any,
): void {
  if (!slot) return;

  if (type === "response.output_text.delta" && slot.type === "text") {
    const delta = String(payload.delta || "");
    slot.block.text += delta;
    stream.push({ type: "text_delta", contentIndex: slot.contentIndex, delta, partial: output });
    return;
  }

  if (
    (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") &&
    slot.type === "thinking"
  ) {
    const delta = String(payload.delta || "");
    slot.block.thinking += delta;
    stream.push({ type: "thinking_delta", contentIndex: slot.contentIndex, delta, partial: output });
    return;
  }

  if (type === "response.function_call_arguments.delta" && slot.type === "toolCall") {
    const delta = String(payload.delta || "");
    slot.block.partialJson += delta;
    const parsed = tryParseJson(slot.block.partialJson);
    if (parsed !== undefined) slot.block.arguments = parsed;
    stream.push({ type: "toolcall_delta", contentIndex: slot.contentIndex, delta, partial: output });
    return;
  }

  if (type === "response.function_call_arguments.done" && slot.type === "toolCall") {
    slot.block.partialJson = String(payload.arguments || slot.block.partialJson);
    slot.block.arguments = tryParseJson(slot.block.partialJson) || {};
  }
}

function handleCodexItemDone(
  payload: any,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  slots: Map<number, any>,
): void {
  const slot = slots.get(payload.output_index);
  slots.delete(payload.output_index);
  if (!slot) return;

  const item = payload.item;

  if (slot.type === "text") {
    slot.block.text =
      item?.content?.map((part: any) => part.text || part.refusal || "").join("") ||
      slot.block.text;
    stream.push({
      type: "text_end",
      contentIndex: slot.contentIndex,
      content: slot.block.text,
      partial: output,
    });
    return;
  }

  if (slot.type === "thinking") {
    slot.block.thinking =
      item?.summary?.map((part: any) => part.text).join("\n\n") ||
      item?.content?.map((part: any) => part.text).join("\n\n") ||
      slot.block.thinking;
    slot.block.thinkingSignature = JSON.stringify(item);
    stream.push({
      type: "thinking_end",
      contentIndex: slot.contentIndex,
      content: slot.block.thinking,
      partial: output,
    });
    return;
  }

  if (slot.type === "toolCall") {
    slot.block.arguments = tryParseJson(item?.arguments || slot.block.partialJson) || {};
    delete slot.block.partialJson;
    stream.push({
      type: "toolcall_end",
      contentIndex: slot.contentIndex,
      toolCall: slot.block,
      partial: output,
    });
  }
}

export function applyCodexSsePayload(
  payload: any,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<Api>,
  slots: Map<number, any>,
): void {
  const type = payload?.type;
  if (!type || type === "response.in_progress" || type === "response.metadata") return;

  if (type === "error") throw new Error(payload.message || JSON.stringify(payload));
  if (type === "response.failed") {
    throw new Error(payload.response?.error?.message || "Codex response failed");
  }

  if (type === "response.created") {
    output.responseId = payload.response?.id || output.responseId;
    return;
  }

  if (type === "response.output_item.added") {
    handleCodexItemAdded(payload, output, stream, slots);
    return;
  }

  if (type === "response.output_item.done") {
    handleCodexItemDone(payload, output, stream, slots);
    return;
  }

  if (type.endsWith(".delta") || type.endsWith(".done")) {
    const slot = slots.get(payload.output_index);
    handleCodexDelta(type, payload, output, stream, slot);
    return;
  }

  if (type === "response.completed" || type === "response.incomplete") {
    output.responseId = payload.response?.id || output.responseId;
    applyCodexUsage(output, payload.response, model);
    output.stopReason =
      type === "response.incomplete"
        ? "length"
        : output.content.some((block) => block.type === "toolCall")
          ? "toolUse"
          : "stop";
  }
}

export async function tryStreamAnyRouterCodex(
  url: string,
  body: Json,
  apiKey: string,
  model: Model<Api>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  sessionId: string,
  metadata: ReturnType<typeof createCodexMetadata>,
  options?: SimpleStreamOptions,
): Promise<void> {
  const headers = createCodexHeaders(apiKey, sessionId, metadata);
  const response = await postSseWithRetry({
    url,
    headers,
    body: JSON.stringify(body),
    signal: options?.signal,
    onResponse: options?.onResponse,
  });

  if (!response.body) throw new Error("Codex stream response body missing");

  const slots = new Map<number, any>();
  let terminal = false;

  for await (const event of iterateSseEvents(response.body)) {
    if (event.data === "[DONE]") continue;
    const payload = tryParseJson(event.data);
    if (!payload) throw new Error(`invalid Codex SSE payload: ${event.data.slice(0, 200)}`);
    applyCodexSsePayload(payload, output, stream, model, slots);
    if (payload.type === "response.completed" || payload.type === "response.incomplete") {
      terminal = true;
    }
  }

  if (!terminal) throw new Error("Codex stream ended before a terminal response event");
}
