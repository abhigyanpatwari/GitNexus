import { request } from '../lib/ipc';
export const loadPlain = () => request('/api/plain');

function forwardPlain(url: string) {
  return request(url);
}
export const loadPlainForwarded = () => forwardPlain('/api/plain-forwarded');
