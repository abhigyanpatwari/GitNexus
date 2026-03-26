export function UserList() {
  const res = fetch('/api/users').then(r => r.json());
  const items = res.data;
  const err = res.error;
  return null;
}
