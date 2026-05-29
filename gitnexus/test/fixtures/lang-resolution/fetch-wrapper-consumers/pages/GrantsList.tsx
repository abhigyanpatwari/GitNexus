import { apiFetch } from '../lib/api-client';

export default function GrantsList() {
  const loadGrants = async () => {
    const res = await apiFetch('/api/grants');
    return res.json();
  };
  return null;
}
