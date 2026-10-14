import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AnyRouterConfig, ProviderConfigFile, StreamMode } from "../types/index.js";

const DEFAULT_CONFIG_PATH = join(homedir(), ".pi", "agent", "anyrouter.json");

export function getConfigPath(): string {
  return process.env.PI_ANYROUTER_CC_CONFIG || DEFAULT_CONFIG_PATH;
}

function resolveConfigValue(value?: string): string {
  if (!value) return "";
  if (value.startsWith("!")) {
    throw new Error(
      "anyrouter does not support shell-command apiKey values. Use a literal key, env var name, or PI_ANYROUTER_CC_API_KEY.",
    );
  }
  return process.env[value] || value;
}

export function loadAnyRouterConfig(): AnyRouterConfig {
  const configPath = getConfigPath();
  let content = "";
  try {
    content = readFileSync(configPath, "utf8");
  } catch {
    throw new Error(
      `Config file not found: ${configPath}. Create ~/.pi/agent/anyrouter.json or set PI_ANYROUTER_CC_CONFIG.`,
    );
  }

  let parsed: ProviderConfigFile;
  try {
    parsed = JSON.parse(content) as ProviderConfigFile;
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const baseUrl = process.env.PI_ANYROUTER_CC_BASE_URL || parsed.baseUrl;
  const apiKey = process.env.PI_ANYROUTER_CC_API_KEY || resolveConfigValue(parsed.apiKey);
  const models = parsed.models || [];

  if (!baseUrl) {
    throw new Error(
      `Missing baseUrl in ${configPath}. You can also set PI_ANYROUTER_CC_BASE_URL.`,
    );
  }
  if (!apiKey) {
    throw new Error(
      `Missing apiKey in ${configPath}. You can also set PI_ANYROUTER_CC_API_KEY.`,
    );
  }
  if (!models.length) {
    throw new Error(`No models configured in ${configPath}. Add at least one model entry.`);
  }

  return { baseUrl, apiKey, models, configPath };
}

export function getStreamMode(): StreamMode {
  const value = String(process.env.PI_ANYROUTER_CC_STREAM_MODE || "force")
    .trim()
    .toLowerCase();
  if (["1", "true", "on", "auto"].includes(value)) return "auto";
  if (["force", "only"].includes(value)) return "force";
  return "off";
}
