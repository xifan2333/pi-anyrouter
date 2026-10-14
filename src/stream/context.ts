import {
  collapseSystemMessages,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Context,
  type Tool,
} from "@earendil-works/pi-ai";

/**
 * Resolves active session tools from Pi's normalized TranscriptContext.
 */
export function resolveCurrentTools(context: Context): Tool[] {
  const transcript = collapseSystemMessages(context);
  return getCurrentTools(transcript.messages) ?? [];
}

/**
 * Resolves active system prompt from Pi's normalized TranscriptContext.
 */
export function resolveCurrentSystemPrompt(context: Context): string {
  const transcript = collapseSystemMessages(context);
  return getCurrentSystemPrompt(transcript.messages) ?? "";
}
