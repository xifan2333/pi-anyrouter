/**
 * Strips invalid Unicode surrogates to avoid JSON encoding and wire format errors.
 */
export function sanitizeText(text: string): string {
  if (typeof text !== "string") return "";
  return text.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}
