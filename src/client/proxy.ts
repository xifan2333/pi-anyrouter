import { ProxyAgent } from "undici";

const PROXY_AGENTS = new Map<string, ProxyAgent>();

function hostMatchesNoProxy(hostname: string, pattern: string): boolean {
  const item = pattern.trim().toLowerCase();
  if (!item) return false;
  if (item === "*") return true;
  const host = hostname.toLowerCase();
  if (item.startsWith(".")) return host === item.slice(1) || host.endsWith(item);
  return host === item || host.endsWith(`.${item}`);
}

export function getProxyUrl(url: string): string | undefined {
  const parsed = new URL(url);
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || "";
  if (noProxy.split(",").some((item) => hostMatchesNoProxy(parsed.hostname, item))) {
    return undefined;
  }
  if (parsed.protocol === "https:") {
    return (
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy
    );
  }
  return process.env.HTTP_PROXY || process.env.http_proxy;
}

export function getProxyAgent(proxyUrl: string): ProxyAgent {
  let agent = PROXY_AGENTS.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent(proxyUrl);
    PROXY_AGENTS.set(proxyUrl, agent);
  }
  return agent;
}
