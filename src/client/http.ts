import { fetch as undiciFetch } from "undici";
import { getProxyAgent, getProxyUrl } from "./proxy.js";

export async function fetchWithProxy(url: string, init: RequestInit): Promise<Response> {
  const proxyUrl = getProxyUrl(url);
  if (!proxyUrl) {
    return fetch(url, init);
  }
  return undiciFetch(url, {
    ...init,
    dispatcher: getProxyAgent(proxyUrl),
  } as any) as unknown as Promise<Response>;
}
