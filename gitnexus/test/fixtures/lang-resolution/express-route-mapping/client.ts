import request from './request';

export async function loadItems() {
  return request.get('/api/items');
}

export async function createClientOnlyItem() {
  return request.post('/api/client-post-only');
}
