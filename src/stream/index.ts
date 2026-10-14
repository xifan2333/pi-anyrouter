import { randomUUID } from "node:crypto";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { loadAnyRouterConfig, getStreamMode } from "../config/index.js";
import {
  recordDiagnosticsError,
  runWithDiagnostics,
  setDiagnosticsField,
} from "../diagnostics/index.js";
import { writeDebugFile } from "../client/index.js";
import {
  applyJsonResponseToOutput,
  buildClaudeCodeRequestBody,
  postJson,
  tryStreamAnyRouterCc,
} from "./claude.js";
import {
  buildCodexRequestBody,
  createCodexMetadata,
  getCodexResponsesUrl,
  isCodexModel,
  tryStreamAnyRouterCodex,
} from "./codex.js";

export function createEmptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function resetOutputState(output: AssistantMessage) {
  output.content = [];
  output.usage = createEmptyUsage();
  output.stopReason = "stop";
  output.errorMessage = undefined;
  output.responseId = undefined;
}

export function streamAnyRouter(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const startTime = Date.now();
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

    await runWithDiagnostics(async () => {
      setDiagnosticsField("modelId", model.id);

      try {
        const config = loadAnyRouterConfig();
        const sessionId = randomUUID();
        const configuredModel = config.models.find((item) => item.id === model.id);

        if (isCodexModel(model.id, configuredModel?.api)) {
          setDiagnosticsField("protocol", "codex-responses");
          const turnId = randomUUID();
          const metadata = createCodexMetadata(sessionId, turnId);
          const { body } = buildCodexRequestBody(model, context, options, sessionId, metadata);

          // Support options.onPayload hook
          let finalBody = body;
          if (options?.onPayload) {
            try {
              const intercepted = await options.onPayload(finalBody);
              if (intercepted && typeof intercepted === "object") {
                finalBody = intercepted as Record<string, any>;
              }
            } catch {
              // Best-effort hook
            }
          }

          stream.push({ type: "start", partial: output });
          await tryStreamAnyRouterCodex(
            getCodexResponsesUrl(config.baseUrl),
            finalBody,
            config.apiKey,
            model,
            output,
            stream,
            sessionId,
            metadata,
            options,
          );

          if (options?.signal?.aborted) throw new Error("Request was aborted");
          setDiagnosticsField("latencyMs", Date.now() - startTime);
          stream.push({
            type: "done",
            reason: output.stopReason as "stop" | "length" | "toolUse",
            message: output,
          });
          stream.end();
          return;
        }

        // Claude Code protocol
        setDiagnosticsField("protocol", "claude-code");
        const url = `${config.baseUrl.replace(/\/$/, "")}/v1/messages?beta=true`;
        const { requestBody } = buildClaudeCodeRequestBody(model, context, options, sessionId);

        let finalRequestBody = requestBody;
        if (options?.onPayload) {
          try {
            const intercepted = await options.onPayload(finalRequestBody);
            if (intercepted && typeof intercepted === "object") {
              finalRequestBody = intercepted as Record<string, any>;
            }
          } catch {
            // Best-effort hook
          }
        }

        stream.push({ type: "start", partial: output });

        const streamMode = getStreamMode();
        if (streamMode !== "off") {
          try {
            await tryStreamAnyRouterCc(
              url,
              finalRequestBody,
              config.apiKey,
              model,
              output,
              stream,
              sessionId,
              options,
            );
            if (options?.signal?.aborted) throw new Error("Request was aborted");
            setDiagnosticsField("latencyMs", Date.now() - startTime);
            stream.push({
              type: "done",
              reason: output.stopReason as "stop" | "length" | "toolUse",
              message: output,
            });
            stream.end();
            return;
          } catch (streamError) {
            if (streamMode === "force" || output.content.length > 0) {
              const errText = `[anyrouter] ${streamError instanceof Error ? streamError.message : String(streamError)}`;
              const contentIndex = output.content.length;
              output.content.push({ type: "text", text: errText } as any);
              output.stopReason = "stop";
              output.errorMessage = errText;
              stream.push({ type: "text_start", contentIndex, partial: output });
              stream.push({ type: "text_delta", contentIndex, delta: errText, partial: output });
              stream.push({ type: "text_end", contentIndex, content: errText, partial: output });
              setDiagnosticsField("latencyMs", Date.now() - startTime);
              recordDiagnosticsError(streamError);
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

        // Non-streaming fallback
        const response = await postJson(
          url,
          finalRequestBody,
          config.apiKey,
          model.id,
          sessionId,
          options,
        );
        applyJsonResponseToOutput(response, output, stream, model);
        setDiagnosticsField("latencyMs", Date.now() - startTime);
        stream.push({
          type: "done",
          reason: output.stopReason as "stop" | "length" | "toolUse",
          message: output,
        });
        stream.end();
      } catch (error) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? `[anyrouter] ${error.message}` : String(error);
        setDiagnosticsField("latencyMs", Date.now() - startTime);
        recordDiagnosticsError(error);
        writeDebugFile("error", model.id, undefined, {
          stopReason: output.stopReason,
          errorMessage: output.errorMessage,
        });
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
      }
    });
  })();

  return stream;
}

export * from "./context.js";
export * from "./claude.js";
export * from "./codex.js";
