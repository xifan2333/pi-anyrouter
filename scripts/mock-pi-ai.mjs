export function calculateCost(_model, _usage) {
  return 0;
}

export function createAssistantMessageEventStream() {
  const events = [];
  return {
    push(event) {
      events.push(event);
    },
    end() {},
  };
}

export function getCurrentSystemPrompt(messages) {
  for (const m of messages) {
    if (m.role === "system") {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) return m.content.map(c => c.text || "").join("\n\n");
    }
  }
  return undefined;
}

export function getCurrentTools(messages) {
  const tools = new Map();
  for (const m of messages) {
    if (m.role !== "system") continue;
    for (const r of m.toolsRemoved ?? []) {
      tools.delete(r.name);
    }
    for (const t of [...(m.toolsAdded ?? []), ...(m.tools ?? [])]) {
      if (t?.name) tools.set(t.name, t);
    }
  }
  return [...tools.values()];
}

export function collapseSystemMessages(context) {
  return context;
}
