const backendUrl = 'http://localhost:4747';
export function fetchWithTimeout(url: string): Promise<Response> {
  return fetch(url);
}
export function fetchRepos(): Promise<Response> {
  return fetchWithTimeout(`${backendUrl}/api/repos`);
}
