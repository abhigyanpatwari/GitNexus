export function GrantsList({ slug }: { slug: string }) {
  const data = fetch(`/api/organizations/${slug}/grants`).then(r => r.json());
  return data;
}
