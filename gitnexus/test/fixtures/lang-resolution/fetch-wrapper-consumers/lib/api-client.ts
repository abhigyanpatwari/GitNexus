const API_BASE = process.env.API_BASE || '';

export async function apiFetch(path: string, opts?: RequestInit) {
  return fetch(`${API_BASE}${path}`, opts);
}
