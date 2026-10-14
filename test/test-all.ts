import assert from "node:assert";
import {
  resolveCurrentTools,
  resolveCurrentSystemPrompt,
} from "../src/stream/context.js";
import {
  buildClaudeCodeRequestBody,
} from "../src/stream/claude.js";
import {
  buildCodexRequestBody,
  createCodexMetadata,
} from "../src/stream/codex.js";
import {
  toClaudeCodeName,
  fromClaudeCodeName,
  sanitizeText,
  redactHeaders,
  redactSecrets,
  parseSseEvent,
  nextSseChunk,
} from "../src/utils/index.js";
import { loadAnyRouterConfig } from "../src/config/index.js";
import type { Context, Model, Tool } from "@earendil-works/pi-ai";

console.log("Starting tests...");

// Test 1: Naming
console.log("Test 1: Tool Naming");
assert.strictEqual(toClaudeCodeName("read"), "Read");
assert.strictEqual(toClaudeCodeName("write"), "Write");
assert.strictEqual(toClaudeCodeName("edit"), "Edit");
assert.strictEqual(toClaudeCodeName("bash"), "Bash");
assert.strictEqual(toClaudeCodeName("find"), "Glob");
assert.strictEqual(toClaudeCodeName("myCustomTool"), "MyCustomTool");

assert.strictEqual(fromClaudeCodeName("Read"), "read");
assert.strictEqual(fromClaudeCodeName("Write"), "write");
assert.strictEqual(fromClaudeCodeName("Edit"), "edit");
assert.strictEqual(fromClaudeCodeName("Bash"), "bash");
assert.strictEqual(fromClaudeCodeName("Glob"), "find");
assert.strictEqual(fromClaudeCodeName("MyCustomTool"), "myCustomTool");

// Test 2: Sanitize and Security
console.log("Test 2: Sanitize & Security");
assert.strictEqual(sanitizeText("Hello\uD800World"), "Hello\uFFFDWorld");
assert.deepStrictEqual(
  redactHeaders({
    authorization: "Bearer secret-token-12345",
    "x-api-key": "my-secret-key",
    "content-type": "application/json",
  }),
  {
    authorization: "Bearer ***",
    "x-api-key": "***",
    "content-type": "application/json",
  },
);
assert.strictEqual(
  redactSecrets("Error with sk-123456789012345678901234567890"),
  "Error with sk-***",
);

// Test 3: SSE Chunk Parsing
console.log("Test 3: SSE Chunk Parsing");
const chunk1 = "event: message_start\ndata: {\"type\":\"message_start\"}\n\nrest";
const parsed1 = nextSseChunk(chunk1);
assert.ok(parsed1);
assert.strictEqual(parsed1.chunk, "event: message_start\ndata: {\"type\":\"message_start\"}");
assert.strictEqual(parsed1.rest, "rest");

const sseEvent = parseSseEvent(parsed1.chunk);
assert.strictEqual(sseEvent.event, "message_start");
assert.strictEqual(sseEvent.data, "{\"type\":\"message_start\"}");

// Test 4: Tool Resolution from TranscriptContext (THE BUG FIX!)
console.log("Test 4: Tool Resolution from TranscriptContext");
const mockTools: Tool[] = [
  {
    name: "read",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "bash",
    description: "Execute bash command",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
];

// In modern pi >= 0.86, context.tools is undefined!
// Tools are inside system messages in context.messages
const modernPiContext: Context = {
  messages: [
    {
      role: "system",
      content: "You are an expert developer.",
      toolsAdded: mockTools,
    } as any,
    {
      role: "user",
      content: "List files",
    },
  ],
  // Note: tools and systemPrompt are undefined on Context!
};

const resolvedTools = resolveCurrentTools(modernPiContext);
assert.strictEqual(resolvedTools.length, 2, "Should resolve 2 tools from TranscriptContext");
assert.strictEqual(resolvedTools[0].name, "read");
assert.strictEqual(resolvedTools[1].name, "bash");

const resolvedPrompt = resolveCurrentSystemPrompt(modernPiContext);
assert.strictEqual(resolvedPrompt, "You are an expert developer.");

// Test tool removal in TranscriptContext
const removalContext: Context = {
  messages: [
    {
      role: "system",
      toolsAdded: mockTools,
    } as any,
    {
      role: "system",
      toolsRemoved: [{ name: "bash" }],
    } as any,
  ],
};
const toolsAfterRemoval = resolveCurrentTools(removalContext);
assert.strictEqual(toolsAfterRemoval.length, 1);
assert.strictEqual(toolsAfterRemoval[0].name, "read");

// Test legacy flat Context fallback
const legacyContext: Context = {
  messages: [],
  systemPrompt: "Legacy prompt",
  tools: [mockTools[0]],
};
assert.strictEqual(resolveCurrentTools(legacyContext).length, 1);
assert.strictEqual(resolveCurrentSystemPrompt(legacyContext), "Legacy prompt");

// Test 5: Claude Code Request Body with Injected Tools
console.log("Test 5: Claude Code Request Body");
const mockModel: Model<any> = {
  id: "claude-opus-4-6",
  name: "Claude Opus 4.6",
  provider: "anyrouter",
  api: "anyrouter-messages",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 500000,
  maxTokens: 32000,
};

const { requestBody, tools: injectedTools, systemPrompt: _systemPrompt } = buildClaudeCodeRequestBody(
  mockModel,
  modernPiContext,
  undefined,
  "test-session-id",
);

assert.strictEqual(injectedTools.length, 2, "Should have 2 injected tools");
assert.ok(requestBody.tools, "requestBody.tools must NOT be undefined!");
assert.strictEqual(requestBody.tools.length, 2);
assert.strictEqual(requestBody.tools[0].name, "Read", "Should convert tool name to PascalCase");
assert.strictEqual(requestBody.tools[1].name, "Bash", "Should convert tool name to PascalCase");
assert.ok(Array.isArray(requestBody.system));
assert.strictEqual(requestBody.system.length, 3);
assert.strictEqual(requestBody.system[2].text, "You are an expert developer.");

// Test 6: Codex Request Body with Injected Tools
console.log("Test 6: Codex Request Body");
const codexMetadata = createCodexMetadata("test-session-id", "test-turn-id");
const { body: codexBody, tools: codexInjectedTools } = buildCodexRequestBody(
  { ...mockModel, id: "gpt-6-astra" },
  modernPiContext,
  undefined,
  "test-session-id",
  codexMetadata,
);

assert.strictEqual(codexInjectedTools.length, 2);
assert.ok(codexBody.tools, "codexBody.tools must NOT be undefined!");
assert.strictEqual(codexBody.tools.length, 2);
assert.strictEqual(codexBody.tools[0].type, "function");
assert.strictEqual(codexBody.tools[0].name, "read");
assert.strictEqual(codexBody.input[0].role, "developer");
assert.strictEqual(codexBody.input[0].content[0].text, "You are an expert developer.");

// Test 7: Config Loading
console.log("Test 7: Config Loading");
const cfg = loadAnyRouterConfig();
assert.ok(cfg.baseUrl.startsWith("http"));
assert.ok(cfg.apiKey.length > 0);
assert.ok(cfg.models.length > 0);

console.log("All unit tests passed successfully! 🎉");
