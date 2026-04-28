export async function createOrder(data: unknown) {
  const res = await fetch('/api/orders', { method: 'POST' });
  return res.json();
}
