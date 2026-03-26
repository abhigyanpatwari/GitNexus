export function SearchBar() {
  const data = fetch('/api/search').then(r => r.json());
  console.log(data.courses);
  console.log(data.articles);
  return null;
}
