// A wrapper around fetch: its callers reach the route through it.
export function apiFetch(path: string) {
  return fetch(path);
}
