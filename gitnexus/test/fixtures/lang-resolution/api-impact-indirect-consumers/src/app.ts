import { fetchRepos } from './client';

export async function loadApp() {
  return fetchRepos();
}
