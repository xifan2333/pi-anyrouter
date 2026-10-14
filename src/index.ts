import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as piAiCompat from "@earendil-works/pi-ai/compat";
import { API_ID, PROVIDER_ID, PROVIDER_NAME, type ProviderModelConfig } from "./types/index.js";
import { DEFAULT_BASE_URL, DEFAULT_MODELS } from "./config/index.js";
import { streamAnyRouter } from "./stream/index.js";
import { getLastDiagnostics } from "./diagnostics/index.js";
import { getProxyUrl } from "./client/proxy.js";
import { redactSecrets } from "./utils/security.js";

type CompatApiProviderRegistrar = (provider: {
  api: typeof API_ID;
  stream: typeof streamAnyRouter;
  streamSimple: typeof streamAnyRouter;
}) => void;

function registerCompatApiProvider(): void {
  const register = (piAiCompat as { registerApiProvider?: CompatApiProviderRegistrar })
    .registerApiProvider;
  if (typeof register === "function") {
    register({
      api: API_ID,
      stream: streamAnyRouter,
      streamSimple: streamAnyRouter,
    });
  }
}

function emitCommandOutput(
  ctx: ExtensionCommandContext,
  text: string,
  type: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, type);
    return;
  }
  if (type === "warning" || type === "error") {
    console.error(text);
    return;
  }
  console.log(text);
}

function mapModels(models: ProviderModelConfig[]) {
  return models.map((model) => ({
    id: model.id,
    name: model.name ? `${model.name} (AnyRouter)` : `${model.id} (AnyRouter)`,
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
  }));
}

export default function (pi: ExtensionAPI): void {
  registerCompatApiProvider();

  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: DEFAULT_BASE_URL,
    apiKey: "$ANYROUTER_API_KEY",
    api: API_ID,
    models: mapModels(DEFAULT_MODELS),
    streamSimple: streamAnyRouter,
  });

  // Diagnostics command
  pi.registerCommand("anyrouter.doctor", {
    description: "Show AnyRouter provider diagnostics and tool injection status",
    handler: async (_args, ctx) => {
      const d = getLastDiagnostics();
      const currentModel = ctx.model;
      const baseUrl = currentModel?.baseUrl || d.endpoint || DEFAULT_BASE_URL;
      const proxy = getProxyUrl(baseUrl) || "none (direct)";

      const toolsInfo =
        d.toolsInjected && d.toolsInjected.length > 0
          ? `${d.toolsInjected.length} tools (${d.toolsInjected.join(", ")})`
          : "none (or not yet executed)";

      const lines = [
        `provider=${PROVIDER_NAME}`,
        `baseUrl=${baseUrl}`,
        `proxy=${proxy}`,
        `lastProtocol=${d.protocol || "none"}`,
        `lastModel=${d.modelId || "none"}`,
        `lastToolsInjected=${toolsInfo}`,
        `lastSystemPromptLength=${d.systemPromptLength != null ? `${d.systemPromptLength} chars` : "none"}`,
        `lastEndpoint=${d.endpoint || "none"}`,
        `lastStatus=${d.status ?? "none"}`,
        `lastRequestId=${d.requestId || "none"}`,
        `lastLatencyMs=${d.latencyMs != null ? `${d.latencyMs}ms` : "none"}`,
        `lastRetryAttempt=${d.retryAttempt ?? 0}`,
        `lastError=${d.error ? redactSecrets(d.error) : "none"}`,
        "transport=native-streamSimple",
      ];

      emitCommandOutput(ctx, `AnyRouter Doctor\n${lines.join("\n")}`);
    },
  });

  // Refresh command
  pi.registerCommand("anyrouter.refresh", {
    description: "Reload AnyRouter models from registry",
    handler: async (_args, ctx) => {
      try {
        if (typeof ctx.modelRegistry?.refresh === "function") {
          await ctx.modelRegistry.refresh({
            force: true,
            providers: [PROVIDER_ID],
          });
        }
        emitCommandOutput(ctx, "AnyRouter models refreshed successfully.", "info");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        emitCommandOutput(ctx, `AnyRouter refresh failed: ${msg}`, "error");
      }
    },
  });

  // Models listing command
  pi.registerCommand("anyrouter.models", {
    description: "List currently available AnyRouter models",
    handler: async (_args, ctx) => {
      const models = ctx.modelRegistry?.getModels
        ? ctx.modelRegistry.getModels(PROVIDER_ID)
        : DEFAULT_MODELS;
      const list = models && models.length > 0 ? models : DEFAULT_MODELS;
      const lines = list.map(
        (m: any, i: number) =>
          `${i + 1}. ${m.id} (${m.name || m.id}) - reasoning: ${m.reasoning ?? true}, maxTokens: ${m.maxTokens ?? 32000}`,
      );
      emitCommandOutput(ctx, `AnyRouter Models (${list.length}):\n${lines.join("\n")}`);
    },
  });
}
