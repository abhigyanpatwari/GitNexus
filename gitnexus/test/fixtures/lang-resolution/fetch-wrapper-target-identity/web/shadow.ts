import { request } from '../lib/http';

export function loadParameter(request: (url: string) => unknown) {
  return request('/api/parameter');
}

export function loadLocal() {
  const request = (channel: string) => channel;
  return request('/api/local');
}
