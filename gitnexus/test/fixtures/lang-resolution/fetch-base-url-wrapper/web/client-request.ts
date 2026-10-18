export async function request(url: string) {
  return fetch(url);
}

export const loadRepos = () => request('/api/repos');
