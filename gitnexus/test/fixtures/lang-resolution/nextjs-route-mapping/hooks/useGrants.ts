export function useGrants() {
  const data = fetch('/api/grants').then(r => r.json());
  return data;
}
