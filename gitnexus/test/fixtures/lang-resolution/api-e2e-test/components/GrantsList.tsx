export async function GrantsList() {
  const res = await fetch('/api/grants');
  const { data, pagination } = await res.json();
  return (
    <ul>
      {data.map((g: any) => <li key={g.id}>{g.title}</li>)}
      <p>Page {pagination.page}</p>
    </ul>
  );
}
