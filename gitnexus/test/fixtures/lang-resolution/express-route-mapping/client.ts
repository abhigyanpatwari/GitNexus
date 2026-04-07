import request from './request';

export async function loadItems() {
  return request.get('/api/items');
}

export async function loadClientOnly() {
  return request.get('/api/client-only');
}

export async function createClientOnly(data: unknown) {
  return request.post('/api/client-post-only', { data });
}
