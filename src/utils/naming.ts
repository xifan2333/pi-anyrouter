const NAME_MAP: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  grep: "Grep",
  find: "Glob",
  glob: "Glob",
  ls: "LS",
  todowrite: "TodoWrite",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  google_search: "Google_Search",
};

const REVERSE_NAME_MAP: Record<string, string> = {
  read: "read",
  write: "write",
  edit: "edit",
  bash: "bash",
  grep: "grep",
  glob: "find",
  ls: "ls",
  todowrite: "todowrite",
  webfetch: "webfetch",
  websearch: "websearch",
  google_search: "google_search",
};

/**
 * Formats a Pi tool name to Claude Code format (PascalCase or mapped alias).
 */
export function toClaudeCodeName(name?: string | null): string {
  if (!name || typeof name !== "string") return name ?? "";
  const mapped = NAME_MAP[name.toLowerCase()];
  if (mapped) return mapped;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Normalizes a Claude Code tool name back to Pi's lowercase/snake_case tool name.
 */
export function fromClaudeCodeName(name?: string | null): string {
  if (!name || typeof name !== "string") return name ?? "";
  const mapped = REVERSE_NAME_MAP[name.toLowerCase()];
  if (mapped) return mapped;
  return name.charAt(0).toLowerCase() + name.slice(1);
}
