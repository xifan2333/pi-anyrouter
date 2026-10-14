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
  extractRequestId,
  nextSseChunk,
  parseSseEvent,
  redactHeaders,
  sanitizeText,
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
import { mapReasoningEffort } from "./claude.js";
import { resolveCurrentSystemPrompt, resolveCurrentTools } from "./context.js";

const CODEX_INSTALLATION_ID = randomUUID();

export function isCodexModel(modelId: string, configuredApi?: string): boolean {
  if (configuredApi) return configuredApi === "openai-codex-responses";
  return /(?:^|[-_.])(gpt|codex)(?:[-_.]|$)/i.test(modelId) || /^o\d(?:[-_.]|$)/i.test(modelId);
}

export function getCodexResponsesUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/responses")) return normalized;
  if (normalized.endsWith("/v1")) return `${normalized}/responses`;
  return `${normalized}/v1/responses`;
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
      if (typeof msg.content === "string") {
        if (msg.content.trim()) {
          input.push({
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: sanitizeText(msg.content) }],
          });
        }
      } else {
        const content = msg.content.map((item) =>
          item.type === "text"
            ? { type: "input_text", text: sanitizeText(item.text) }
            : {
                type: "input_image",
                detail: "auto",
                image_url: `data:${item.mimeType};base64,${item.data}`,
              },
        );
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
      const text = toolMsg.content
        .filter((item) => item.type === "text")
        .map((item) => (item as TextContent).text)
        .join("\n");
      const images = toolMsg.content.filter((item) => item.type === "image") as ImageContent[];
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
      input.push({
        type: "function_call_output",
        call_id: toolMsg.toolCallId.split("|")[0],
        output,
      });
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
  // CRITICAL FIX: Resolve tools and system prompt from TranscriptContext
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
      const block = {
        type: "toolCall",
        id: `${item.call_id}|${item.id}`,
        name: item.name,
        arguments: {},
        partialJson: item.arguments || "",
      };
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
    stream.push({
      type: "text_delta",
      contentIndex: slot.contentIndex,
      delta: String(payload.delta || ""),
      partial: output,
    });
  } else if (
    (type === "response.reasoning_summary_text.delta" ||
      type === "response.reasoning_text.delta") &&
    slot?.type === "thinking"
  ) {
    slot.block.thinking += String(payload.delta || "");
    stream.push({
      type: "thinking_delta",
      contentIndex: slot.contentIndex,
      delta: String(payload.delta || ""),
      partial: output,
    });
  } else if (type === "response.function_call_arguments.delta" && slot?.type === "toolCall") {
    slot.block.partialJson += String(payload.delta || "");
    const parsed = tryParseJson(slot.block.partialJson);
    if (parsed !== undefined) slot.block.arguments = parsed;
    stream.push({
      type: "toolcall_delta",
      contentIndex: slot.contentIndex,
      delta: String(payload.delta || ""),
      partial: output,
    });
  } else if (type === "response.function_call_arguments.done" && slot?.type === "toolCall") {
    slot.block.partialJson = String(payload.arguments || slot.block.partialJson);
    slot.block.arguments = tryParseJson(slot.block.partialJson) || {};
  } else if (type === "response.output_item.done") {
    const item = payload.item;
    if (slot?.type === "text" && item?.type === "message") {
      slot.block.text =
        item.content?.map((part: any) => part.text || part.refusal || "").join("") ||
        slot.block.text;
      stream.push({
        type: "text_end",
        contentIndex: slot.contentIndex,
        content: slot.block.text,
        partial: output,
      });
    } else if (slot?.type === "thinking" && item?.type === "reasoning") {
      slot.block.thinking =
        item.summary?.map((part: any) => part.text).join("\n\n") ||
        item.content?.map((part: any) => part.text).join("\n\n") ||
        slot.block.thinking;
      slot.block.thinkingSignature = JSON.stringify(item);
      stream.push({
        type: "thinking_end",
        contentIndex: slot.contentIndex,
        content: slot.block.thinking,
        partial: output,
      });
    } else if (slot?.type === "toolCall" && item?.type === "function_call") {
      slot.block.arguments = tryParseJson(item.arguments || slot.block.partialJson) || {};
      delete slot.block.partialJson;
      stream.push({
        type: "toolcall_end",
        contentIndex: slot.contentIndex,
        toolCall: slot.block,
        partial: output,
      });
    }
    slots.delete(payload.output_index);
  } else if (type === "response.completed" || type === "response.incomplete") {
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
  const bodyText = JSON.stringify(body);
  const maxRetries = getMaxRetries();
  let response: Response | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const headers = createCodexHeaders(apiKey, sessionId, metadata);
    if (attempt === 0) {
      writeDebugFile("request", model.id, undefined, {
        url,
        headers: redactHeaders(headers),
        body,
        transport: "codex-sse",
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

    if (response.ok && (response.headers.get("content-type") || "").includes("text/event-stream")) {
      break;
    }
    const raw = await response.text();
    const parsed = tryParseJson(raw) || { raw };
    const requestId = extractRequestId(parsed, response.headers);
    setDiagnosticsField("requestId", requestId);

    writeDebugFile("error", model.id, requestId, {
      status: response.status,
      requestId,
      body: parsed,
      raw,
      transport: "codex-sse",
      retryAttempt: attempt,
    });
    if (!response.ok && attempt < maxRetries && isRetryableStatus(response.status)) {
      await delay(
        getRetryDelayMs(attempt, parseRetryAfterMs(response.headers.get("retry-after"))),
      );
      response = undefined;
      continue;
    }
    throw new Error(raw || `HTTP ${response.status}`);
  }

  if (!response?.body) throw new Error("Codex stream response body missing");

  if (options?.onResponse) {
    try {
      options.onResponse(response);
    } catch {
      // Best-effort hook
    }
  }

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
        if (payload.type === "response.completed" || payload.type === "response.incomplete") {
          terminal = true;
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
      if (!payload) throw new Error(`invalid Codex SSE payload: ${event.data.slice(0, 200)}`);
      applyCodexSsePayload(payload, output, stream, model, slots);
      if (payload.type === "response.completed" || payload.type === "response.incomplete") {
        terminal = true;
      }
    }
  }

  if (!terminal) throw new Error("Codex stream ended before a terminal response event");

  const reqId = response.headers.get("x-oneapi-request-id") || undefined;
  setDiagnosticsField("requestId", reqId);

  writeDebugFile("response", model.id, reqId, {
    status: response.status,
    responseId: output.responseId,
    stopReason: output.stopReason,
    usage: output.usage,
    transport: "codex-sse",
  });
}
