export async function useGrants() {
  const result = await fetch('/api/grants');
  const data = await result.json();
  return data.items;
}
