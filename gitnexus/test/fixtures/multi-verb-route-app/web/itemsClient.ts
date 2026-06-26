// Verb-less consumers: a fetch() call carries no statically-known HTTP method,
// so each call matches by URL and must connect to EVERY Route node at that URL
// (both GET /api/items and POST /api/items).
export async function loadItems() {
  const res = await fetch('/api/items');
  return res.json();
}

export async function addItem() {
  const res = await fetch('/api/items', { method: 'POST' });
  return res.json();
}

export async function loadWidgets() {
  const res = await fetch('/api/widgets');
  return res.json();
}
