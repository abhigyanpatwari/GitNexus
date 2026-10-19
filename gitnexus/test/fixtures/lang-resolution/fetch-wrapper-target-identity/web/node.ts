import fetch from 'node-fetch';
export function nodeRequest(url: string) {
  return fetch(url);
}
export const loadNode = () => nodeRequest('/api/node');
