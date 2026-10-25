// The one function that sends the request; its callers never mention the URL.
export async function fetchRepos() {
  const res = await fetch('/api/repos');
  return res.json();
}

export function describeClient() {
  return 'repos client';
}
