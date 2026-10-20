export function destructuredRequest(url: string, { fetch = globalThis.fetch } = {}) {
  return fetch(url);
}
