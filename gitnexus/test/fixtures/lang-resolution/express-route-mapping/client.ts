import request from './request';

export async function loadItems() {
  return request.get('/api/items');
}

export async function createClientOnly() {
  return request.post('/api/client-only');
}
