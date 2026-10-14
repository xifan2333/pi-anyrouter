import type { Context, Tool } from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";

export interface SystemMessageLike {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  sections?: Record<string, unknown>;
  toolsAdded?: Tool[];
  toolsRemoved?: Array<{ name: string }>;
  tools?: Tool[];
}

function extractTranscriptTools(messages: readonly any[]): Tool[] {
  const tools = new Map<string, Tool>();
  for (const message of messages) {
    if (message?.role !== "system") continue;
    for (const tool of message.toolsRemoved ?? []) {
      if (tool && typeof tool.name === "string") {
        tools.delete(tool.name);
      }
    }
    for (const tool of [...(message.toolsAdded ?? []), ...(message.tools ?? [])]) {
      if (tool && typeof tool.name === "string") {
        tools.set(tool.name, tool);
      }
    }
  }
  return [...tools.values()];
}

function extractTranscriptSystemPrompt(messages: readonly any[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message?.role !== "system") continue;
    if (message.sections && typeof message.sections === "object") {
      const sectionParts = Object.values(message.sections).filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      );
      if (sectionParts.length > 0) {
        parts.push(sectionParts.join("\n\n"));
        continue;
      }
    }
    if (typeof message.content === "string" && message.content.trim()) {
      parts.push(message.content);
    } else if (Array.isArray(message.content)) {
      const texts = message.content
        .map((block) => (typeof block === "string" ? block : block?.text || ""))
        .filter((text) => text.trim().length > 0);
      if (texts.length > 0) parts.push(texts.join("\n\n"));
    }
  }
  return parts.join("\n\n");
}

/**
 * Pi >= 0.86 hands providers a normalized TranscriptContext: the system prompt and
 * tool declarations live in system messages and must be read with
 * `getCurrentSystemPrompt()` / `getCurrentTools()`.
 *
 * Older releases still pass flat Context fields. This function resolves both
 * so requests are guaranteed to include active session tools.
 */
export function resolveCurrentTools(context: Context): Tool[] {
  // 1. Try pi-ai's official getCurrentTools helper
  const helper = (piAi as any).getCurrentTools;
  if (typeof helper === "function") {
    try {
      const collapsed =
        typeof (piAi as any).collapseSystemMessages === "function"
          ? (piAi as any).collapseSystemMessages(context)
          : context;
      const fromHelper = helper(collapsed.messages ?? context.messages ?? []);
      if (Array.isArray(fromHelper) && fromHelper.length > 0) {
        return fromHelper;
      }
    } catch {
      // Fall through to manual transcript extraction
    }
  }

  // 2. Extract tools from transcript system messages (toolsAdded/toolsRemoved/tools)
  try {
    const fromTranscript = extractTranscriptTools(context.messages ?? []);
    if (fromTranscript.length > 0) {
      return fromTranscript;
    }
  } catch {
    // Fall through to legacy context field
  }

  // 3. Fall back to legacy flat Context field if present
  if (Array.isArray(context.tools) && context.tools.length > 0) {
    return context.tools;
  }

  return [];
}

/**
 * Resolves active system prompt from TranscriptContext or flat Context.
 */
export function resolveCurrentSystemPrompt(
  context: Context,
  fallback = "You are an expert coding assistant operating inside pi.",
): string {
  // 1. Try pi-ai's official getCurrentSystemPrompt helper
  const helper = (piAi as any).getCurrentSystemPrompt;
  if (typeof helper === "function") {
    try {
      const collapsed =
        typeof (piAi as any).collapseSystemMessages === "function"
          ? (piAi as any).collapseSystemMessages(context)
          : context;
      const fromHelper = helper(collapsed.messages ?? context.messages ?? []);
      if (typeof fromHelper === "string" && fromHelper.trim()) {
        return fromHelper.trim();
      }
    } catch {
      // Fall through to manual transcript extraction
    }
  }

  // 2. Extract system prompt from transcript system messages
  try {
    const fromTranscript = extractTranscriptSystemPrompt(context.messages ?? []);
    if (fromTranscript.trim()) {
      return fromTranscript.trim();
    }
  } catch {
    // Fall through to legacy field
  }

  // 3. Fall back to legacy flat Context field
  if (context.systemPrompt && context.systemPrompt.trim()) {
    return context.systemPrompt.trim();
  }

  return fallback;
}
