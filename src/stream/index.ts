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
import {
  recordDiagnosticsError,
  runWithDiagnostics,
  setDiagnosticsField,
} from "../diagnostics/index.js";
import {
  buildClaudeCodeRequestBody,
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

async function interceptPayload(body: any, hook?: (payload: any) => any): Promise<any> {
  if (!hook) return body;
  try {
    const intercepted = await hook(body);
    if (intercepted && typeof intercepted === "object") {
      return intercepted;
    }
  } catch {
    // Best-effort hook
  }
  return body;
}

function finalizeSuccess(
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  startTime: number,
  signal?: AbortSignal,
): void {
  if (signal?.aborted) throw new Error("Request was aborted");
  setDiagnosticsField("latencyMs", Date.now() - startTime);
  stream.push({
    type: "done",
    reason: output.stopReason as "stop" | "length" | "toolUse",
    message: output,
  });
  stream.end();
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
        const apiKey = options?.apiKey;
        if (!apiKey) {
          throw new Error("No API key provided for AnyRouter. Please configure your API key in Pi auth or settings.");
        }

        const baseUrl = model.baseUrl ? model.baseUrl.replace(/\/+$/, "") : "";
        if (!baseUrl) {
          throw new Error("No baseUrl provided for AnyRouter model.");
        }

        const sessionId = randomUUID();
        stream.push({ type: "start", partial: output });

        if (isCodexModel(model.id, model.api)) {
          setDiagnosticsField("protocol", "codex-responses");
          const turnId = randomUUID();
          const metadata = createCodexMetadata(sessionId, turnId);
          const { body } = buildCodexRequestBody(model, context, options, sessionId, metadata);
          const finalBody = await interceptPayload(body, options?.onPayload);

          await tryStreamAnyRouterCodex(
            getCodexResponsesUrl(baseUrl),
            finalBody,
            apiKey,
            model,
            output,
            stream,
            sessionId,
            metadata,
            options,
          );
          finalizeSuccess(stream, output, startTime, options?.signal);
          return;
        }

        // Claude Code protocol
        setDiagnosticsField("protocol", "claude-code");
        const url = `${baseUrl}/v1/messages?beta=true`;
        const { requestBody } = buildClaudeCodeRequestBody(model, context, options, sessionId);
        const finalRequestBody = await interceptPayload(requestBody, options?.onPayload);

        await tryStreamAnyRouterCc(
          url,
          finalRequestBody,
          apiKey,
          model,
          output,
          stream,
          sessionId,
          options,
        );
        finalizeSuccess(stream, output, startTime, options?.signal);
      } catch (error) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? `[anyrouter] ${error.message}` : String(error);
        setDiagnosticsField("latencyMs", Date.now() - startTime);
        recordDiagnosticsError(error);
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
