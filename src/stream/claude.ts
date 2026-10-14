import { randomBytes } from "node:crypto";
import {
  calculateCost,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type Tool,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  ANTHROPIC_BETA,
  CLAUDE_CODE_VERSION,
  CLAUDE_CODE_VERSION_BUILD,
  STAINLESS_ARCH,
  STAINLESS_OS,
  STAINLESS_PACKAGE_VERSION,
  STAINLESS_RUNTIME,
  STAINLESS_RUNTIME_VERSION,
  type Json,
} from "../types/index.js";
import {
  extractRequestId,
  fromClaudeCodeName,
  nextSseChunk,
  parseSseEvent,
  redactHeaders,
  sanitizeText,
  toClaudeCodeName,
  tryParseJson,
} from "../utils/index.js";
import {
  delay,
  fetchWithProxy,
  getMaxRetries,
  getRetryDelayMs,
  isRetryableStatus,
  parseRetryAfterMs,
  writeDebugFile,
} from "../client/index.js";
import { setDiagnosticsField } from "../diagnostics/index.js";
import { resolveCurrentSystemPrompt, resolveCurrentTools } from "./context.js";

const CLAUDE_DEVICE_ID = randomBytes(32).toString("hex");

export function mapReasoningEffort(level?: SimpleStreamOptions["reasoning"]): string {
  switch (level) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    default:
      return "medium";
  }
}

export function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case "end_turn":
    case "pause_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    default:
      return "error";
  }
}

export function getClaudeCodeHeaders(apiKey: string, retryCount = 0, sessionId: string): Record<string, string> {
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

export function createClaudeCodeMetadata(sessionId: string): { user_id: string } {
  return {
    user_id: JSON.stringify({
      device_id: CLAUDE_DEVICE_ID,
      account_uuid: "",
      session_id: sessionId,
    }),
  };
}

export function createClaudeCodeSystem(systemPrompt: string): Array<{
  type: string;
  text: string;
  cache_control?: { type: string };
}> {
  return [
    {
      type: "text",
      text: `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION_BUILD}; cc_entrypoint=sdk-cli;`,
    },
    {
      type: "text",
      text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: sanitizeText(systemPrompt),
      cache_control: { type: "ephemeral" },
    },
  ];
}

export function convertContentBlocks(content: (TextContent | ImageContent)[]): any {
  const hasImages = content.some((c) => c.type === "image");
  if (!hasImages) {
    return sanitizeText(content.map((c) => (c as TextContent).text).join("\n"));
  }

  const blocks = content.map((block) => {
    if (block.type === "text") return { type: "text", text: sanitizeText(block.text) };
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: block.mimeType,
        data: block.data,
      },
    };
  });
  if (!blocks.some((b) => b.type === "text")) {
    blocks.unshift({ type: "text", text: "(see attached image)" });
  }
  return blocks;
}

export function convertMessages(messages: Message[]): any[] {
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
            : {
                type: "image",
                source: { type: "base64", media_type: item.mimeType, data: item.data },
              },
        );
        if (blocks.length > 0) params.push({ role: "user", content: blocks });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const blocks: any[] = [];
      for (const block of msg.content) {
        if (block.type === "text" && block.text.trim()) {
          blocks.push({ type: "text", text: sanitizeText(block.text) });
        } else if (block.type === "thinking" && block.thinking.trim()) {
          if ((block as ThinkingContent).thinkingSignature) {
            blocks.push({
              type: "thinking",
              thinking: sanitizeText(block.thinking),
              signature: (block as ThinkingContent).thinkingSignature,
            });
          } else {
            blocks.push({ type: "text", text: sanitizeText(block.thinking) });
          }
        } else if (block.type === "toolCall") {
          blocks.push({
            type: "tool_use",
            id: block.id,
            name: toClaudeCodeName(block.name),
            input: block.arguments,
          });
        }
      }
      if (blocks.length > 0) params.push({ role: "assistant", content: blocks });
      continue;
    }

    if (msg.role === "toolResult") {
      const toolResults: any[] = [];
      const pushToolResult = (toolMsg: ToolResultMessage) => {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolMsg.toolCallId,
          content: convertContentBlocks(toolMsg.content),
          is_error: toolMsg.isError,
        });
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

export function convertTools(tools: Tool[]): any[] {
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

export function updateUsageFromAnthropic(
  output: AssistantMessage,
  usage: any,
  model: Model<Api>,
): void {
  if (usage?.input_tokens != null) output.usage.input = usage.input_tokens;
  if (usage?.output_tokens != null) output.usage.output = usage.output_tokens;
  if (usage?.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
  if (usage?.cache_creation_input_tokens != null) {
    output.usage.cacheWrite = usage.cache_creation_input_tokens;
  }
  output.usage.totalTokens =
    output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
  calculateCost(model, output.usage);
}

export function applySsePayloadEvent(
  payload: any,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<Api>,
  blockIndexByEventIndex: Map<number, number>,
): void {
  if (!payload?.type || payload.type === "ping" || payload.type === "message_stop") return;

  if (payload.type === "error") {
    const errorText =
      payload?.error?.message || payload?.error || payload?.message || JSON.stringify(payload);
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
      stream.push({
        type: "text_delta",
        contentIndex,
        delta: String(payload.delta.text || ""),
        partial: output,
      });
      return;
    }
    if (payload.delta?.type === "thinking_delta" && block.type === "thinking") {
      block.thinking += String(payload.delta.thinking || "");
      stream.push({
        type: "thinking_delta",
        contentIndex,
        delta: String(payload.delta.thinking || ""),
        partial: output,
      });
      return;
    }
    if (payload.delta?.type === "input_json_delta" && block.type === "toolCall") {
      block.partialJson += String(payload.delta.partial_json || "");
      try {
        block.arguments = JSON.parse(block.partialJson);
      } catch {
        // partial json is expected during streaming
      }
      stream.push({
        type: "toolcall_delta",
        contentIndex,
        delta: String(payload.delta.partial_json || ""),
        partial: output,
      });
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

export function applyJsonResponseToOutput(
  response: any,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<Api>,
): void {
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
      output.content.push({
        type: "thinking",
        thinking: String(block.thinking || ""),
        thinkingSignature: block.signature || "",
      } as any);
      const contentIndex = output.content.length - 1;
      stream.push({ type: "thinking_start", contentIndex, partial: output });
      if (block.thinking) {
        stream.push({
          type: "thinking_delta",
          contentIndex,
          delta: String(block.thinking),
          partial: output,
        });
      }
      stream.push({
        type: "thinking_end",
        contentIndex,
        content: String(block.thinking || ""),
        partial: output,
      });
    } else if (block?.type === "tool_use") {
      const toolCall = {
        type: "toolCall" as const,
        id: block.id,
        name: fromClaudeCodeName(block.name),
        arguments: block.input || {},
      };
      output.content.push(toolCall as any);
      const contentIndex = output.content.length - 1;
      stream.push({ type: "toolcall_start", contentIndex, partial: output });
      stream.push({
        type: "toolcall_delta",
        contentIndex,
        delta: JSON.stringify(toolCall.arguments),
        partial: output,
      });
      stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
    }
  }
}

export async function tryStreamAnyRouterCc(
  url: string,
  body: Json,
  apiKey: string,
  model: Model<Api>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  sessionId: string,
  options?: SimpleStreamOptions,
): Promise<void> {
  const requestBody = { ...body, stream: true };
  const bodyText = JSON.stringify(requestBody);
  const maxRetries = getMaxRetries();
  let response: Response | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
        signal: options?.signal,
        headers,
        body: bodyText,
      });
    } catch (error) {
      if (attempt < maxRetries && !options?.signal?.aborted) {
        await delay(getRetryDelayMs(attempt));
        continue;
      }
      throw error;
    }

    setDiagnosticsField("status", response.status);
    setDiagnosticsField("endpoint", url);
    setDiagnosticsField("retryAttempt", attempt);

    const contentType = response.headers.get("content-type") || "";
    if (response.ok && contentType.includes("text/event-stream")) break;

    const raw = await response.text();
    const parsed = tryParseJson(raw) || { raw };
    const requestId = extractRequestId(parsed, response.headers);
    setDiagnosticsField("requestId", requestId);

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
      const retryBlockIndex = output.content.length;
      const retryText = `⏳ ${response.status} — retrying (${attempt + 1}/${maxRetries})…`;
      output.content.push({ type: "text", text: retryText } as any);
      stream.push({ type: "text_start", contentIndex: retryBlockIndex, partial: output });
      stream.push({
        type: "text_delta",
        contentIndex: retryBlockIndex,
        delta: retryText,
        partial: output,
      });
      stream.push({
        type: "text_end",
        contentIndex: retryBlockIndex,
        content: retryText,
        partial: output,
      });
      await delay(
        getRetryDelayMs(attempt, parseRetryAfterMs(response.headers.get("retry-after"))),
      );
      response = undefined;
      continue;
    }
    if (response.ok) {
      throw new Error(`stream response was not SSE (content-type=${contentType || "<missing>"})`);
    }
    throw new Error(raw || `HTTP ${response.status}`);
  }

  if (!response?.body) throw new Error("stream response body missing");

  // Call options.onResponse hook if provided
  if (options?.onResponse) {
    try {
      options.onResponse(response);
    } catch {
      // Best-effort hook
    }
  }

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
        if (!payload && event.data !== "[DONE]") {
          throw new Error(`invalid SSE payload: ${event.data.slice(0, 200)}`);
        }
        if (payload) {
          applySsePayloadEvent(payload, output, stream, model, blockIndexByEventIndex);
        }
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

  const reqId = response.headers.get("x-oneapi-request-id") || undefined;
  setDiagnosticsField("requestId", reqId);

  writeDebugFile("response", model.id, reqId, {
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

export async function postJson(
  url: string,
  body: Json,
  apiKey: string,
  modelId: string,
  sessionId: string,
  options?: SimpleStreamOptions,
): Promise<any> {
  const maxRetries = getMaxRetries();
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
        signal: options?.signal,
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

    setDiagnosticsField("status", response.status);
    setDiagnosticsField("endpoint", url);
    setDiagnosticsField("retryAttempt", attempt);

    if (options?.onResponse) {
      try {
        options.onResponse(response);
      } catch {
        // Best-effort hook
      }
    }

    const text = await response.text();
    lastErrorText = text;
    let parsed: any = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    const requestId = extractRequestId(parsed, response.headers);
    setDiagnosticsField("requestId", requestId);

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
      await delay(
        getRetryDelayMs(attempt, parseRetryAfterMs(response.headers.get("retry-after"))),
      );
      continue;
    }
    throw new Error(text || `HTTP ${response.status}`);
  }

  throw new Error(lastErrorText || "HTTP request failed after retries");
}

export function buildClaudeCodeRequestBody(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  sessionId: string,
): { requestBody: Json; tools: Tool[]; systemPrompt: string } {
  // CRITICAL FIX: Resolve tools and system prompt from TranscriptContext
  const tools = resolveCurrentTools(context);
  const systemPrompt = resolveCurrentSystemPrompt(context);

  setDiagnosticsField("toolsInjected", tools.map((t) => t.name));
  setDiagnosticsField("systemPromptLength", systemPrompt.length);

  const requestBody: Json = {
    model: model.id,
    messages: convertMessages(context.messages),
    max_tokens: options?.maxTokens || model.maxTokens || 32000,
    stream: false,
    metadata: createClaudeCodeMetadata(sessionId),
    system: createClaudeCodeSystem(systemPrompt),
    context_management: {
      edits: [{ type: "clear_thinking_20251015", keep: "all" }],
    },
  };

  if (tools.length > 0) {
    requestBody.tools = convertTools(tools);
  }

  if (options?.reasoning && model.reasoning) {
    requestBody.thinking = { type: "adaptive", display: "omitted" };
    requestBody.output_config = { effort: mapReasoningEffort(options.reasoning) };
  }

  return { requestBody, tools, systemPrompt };
}
