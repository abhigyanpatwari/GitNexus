import request from './request';

export async function loadItems() {
  return request.get('/api/items');
}

export async function createItem() {
  return request.post('/api/items/create');
}

export async function updateItem() {
  return request.put('/api/items/update');
}

export async function patchItem() {
  return request.patch('/api/items/patch');
}

export async function deleteItem() {
  return request.delete('/api/items/delete');
}

export async function createClientOnly() {
  return request.post('/api/client-only');
}
