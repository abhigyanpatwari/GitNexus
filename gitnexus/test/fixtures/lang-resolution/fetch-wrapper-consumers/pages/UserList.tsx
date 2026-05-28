import { apiFetch } from '../lib/api-client';

export default function UserList() {
  const loadUsers = async () => {
    const res = await apiFetch('/api/users');
    return res.json();
  };
  return null;
}
