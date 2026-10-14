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
  const lower = name.toLowerCase();
  for (const [from, to] of Object.entries(NAME_MAP)) {
    if (to.toLowerCase() === lower) return from;
  }
  return name.charAt(0).toLowerCase() + name.slice(1);
}
