export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted = { ...headers };
  if (redacted.authorization) redacted.authorization = "Bearer ***";
  if (redacted.Authorization) redacted.Authorization = "Bearer ***";
  if (redacted["x-api-key"]) redacted["x-api-key"] = "***";
  return redacted;
}

export function redactSecrets(text: string): string {
  if (typeof text !== "string") return "";
  return text
    .replace(/sk-[a-zA-Z0-9_-]{20,}/g, "sk-***")
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, "Bearer ***");
}

export function extractRequestId(parsed: any, headers?: Headers): string | undefined {
  return (
    parsed?.error?.message?.match(/request id:\s*([^)]+)/i)?.[1] ||
    headers?.get("x-oneapi-request-id") ||
    headers?.get("x-request-id") ||
    undefined
  );
}

export function tryParseJson(text: string): any {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return undefined;
  }
}
