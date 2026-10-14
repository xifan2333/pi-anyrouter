export class ProxyAgent {
  constructor(url) {
    this.url = url;
  }
}

export async function fetch(url, init) {
  return globalThis.fetch(url, init);
}
