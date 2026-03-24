export async function useMulti() {
  const [grantsRes, secureRes] = await Promise.all([
    fetch('/api/grants'),
    fetch('/api/secure'),
  ]);
  const grants = await grantsRes.json();
  const secure = await secureRes.json();
  return { grants: grants.data, secure: secure.items, meta: grants.meta };
}
