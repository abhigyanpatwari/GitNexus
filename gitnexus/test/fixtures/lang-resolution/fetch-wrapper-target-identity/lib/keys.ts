export function keyRequest(url: string) {
  return fetch(url);
}
export const api = { keyRequest: (url: string) => keyRequest(url) };
export const loadKey = () => keyRequest('/api/key');
