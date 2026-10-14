export async function resolve(specifier, context, nextResolve) {
  // If it's a relative import ending with .js, check if .ts exists
  if (specifier.endsWith(".js") && (specifier.startsWith("./") || specifier.startsWith("../"))) {
    try {
      return await nextResolve(specifier, context);
    } catch {
      const tsSpecifier = specifier.slice(0, -3) + ".ts";
      return await nextResolve(tsSpecifier, context);
    }
  }

  if (specifier === "undici") {
    return {
      url: new URL("./mock-undici.mjs", import.meta.url).href,
      format: "module",
      shortCircuit: true,
    };
  }

  // If mock for @earendil-works/pi-ai or @earendil-works/pi-coding-agent is needed in standalone test
  if (specifier === "@earendil-works/pi-ai") {
    try {
      return await nextResolve(specifier, context);
    } catch {
      return {
        url: new URL("./mock-pi-ai.mjs", import.meta.url).href,
        format: "module",
        shortCircuit: true,
      };
    }
  }

  if (specifier === "@earendil-works/pi-ai/compat") {
    try {
      return await nextResolve(specifier, context);
    } catch {
      return {
        url: new URL("./mock-pi-ai-compat.mjs", import.meta.url).href,
        format: "module",
        shortCircuit: true,
      };
    }
  }

  return await nextResolve(specifier, context);
}
