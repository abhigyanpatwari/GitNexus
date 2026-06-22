export async function fetchUsers() {
  const res = await fetch('/api/users');
  return res.json();
}

export async function createUserReq(data: { name: string }) {
  const res = await fetch('/api/users', {
    method: 'POST',
    body: JSON.stringify(data),
    headers: { 'Content-Type': 'application/json' },
  });
  return res.json();
}
