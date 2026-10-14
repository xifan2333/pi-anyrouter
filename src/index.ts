import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as piAiCompat from "@earendil-works/pi-ai/compat";
import { API_ID, PROVIDER_ID, PROVIDER_NAME, type AnyRouterConfig } from "./types/index.js";
import { getConfigPath, loadAnyRouterConfig } from "./config/index.js";
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
  if (type === "warning" || type === "error") console.error(text);
  else console.log(text);
}

function mapModels(config: AnyRouterConfig) {
  return config.models.map((model) => ({
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

  let activeConfig: AnyRouterConfig | undefined;
  try {
    activeConfig = loadAnyRouterConfig();
  } catch (error) {
    console.error(
      `[anyrouter] Failed to load config: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(`[anyrouter] Config path: ${getConfigPath()}`);
  }

  if (activeConfig) {
    pi.registerProvider(PROVIDER_ID, {
      baseUrl: activeConfig.baseUrl,
      apiKey: activeConfig.apiKey,
      api: API_ID,
      models: mapModels(activeConfig),
      refreshModels: async () => {
        try {
          const reloaded = loadAnyRouterConfig();
          activeConfig = reloaded;
          return mapModels(reloaded);
        } catch {
          return activeConfig ? mapModels(activeConfig) : [];
        }
      },
      streamSimple: streamAnyRouter,
    });
  }

  // Diagnostics command
  pi.registerCommand("anyrouter.doctor", {
    description: "Show AnyRouter provider diagnostics and tool injection status",
    handler: async (_args, ctx) => {
      const d = getLastDiagnostics();
      const configPath = getConfigPath();
      let cfg: AnyRouterConfig | undefined = activeConfig;
      try {
        cfg = loadAnyRouterConfig();
      } catch {
        // use last active
      }

      const maskedKey = cfg?.apiKey
        ? `${cfg.apiKey.slice(0, 6)}...${cfg.apiKey.slice(-4)}`
        : "not-configured";
      const proxy = cfg ? getProxyUrl(cfg.baseUrl) || "none (direct)" : "unknown";

      const toolsInfo =
        d.toolsInjected && d.toolsInjected.length > 0
          ? `${d.toolsInjected.length} tools (${d.toolsInjected.join(", ")})`
          : "none (or not yet executed)";

      const lines = [
        `provider=${PROVIDER_NAME}`,
        `configPath=${configPath}`,
        `baseUrl=${cfg?.baseUrl || "none"}`,
        `apiKey=${maskedKey}`,
        `modelsCount=${cfg?.models.length ?? 0}`,
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
    description: "Reload AnyRouter configuration and model catalog",
    handler: async (_args, ctx) => {
      try {
        const reloaded = loadAnyRouterConfig();
        activeConfig = reloaded;
        if (typeof ctx.modelRegistry?.refresh === "function") {
          await ctx.modelRegistry.refresh({
            force: true,
            providers: [PROVIDER_ID],
          });
        }
        emitCommandOutput(
          ctx,
          `AnyRouter refreshed: loaded ${reloaded.models.length} models from ${reloaded.configPath}`,
          "info",
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        emitCommandOutput(ctx, `AnyRouter refresh failed: ${msg}`, "error");
      }
    },
  });

  // Models listing command
  pi.registerCommand("anyrouter.models", {
    description: "List currently configured AnyRouter models",
    handler: async (_args, ctx) => {
      let cfg = activeConfig;
      try {
        cfg = loadAnyRouterConfig();
      } catch {
        // use activeConfig
      }
      if (!cfg || !cfg.models.length) {
        emitCommandOutput(ctx, "No models configured in AnyRouter.", "warning");
        return;
      }
      const lines = cfg.models.map(
        (m, i) =>
          `${i + 1}. ${m.id} (${m.name || m.id}) - reasoning: ${m.reasoning ?? true}, maxTokens: ${m.maxTokens ?? 32000}`,
      );
      emitCommandOutput(ctx, `AnyRouter Models (${cfg.models.length}):\n${lines.join("\n")}`);
    },
  });
}
