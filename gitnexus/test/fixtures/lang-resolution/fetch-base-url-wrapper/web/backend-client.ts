import { resilientFetch } from '../shared/resilient-fetch';

let _backendUrl = 'http://localhost:4747';

export const setBackendUrl = (url: string) => {
  _backendUrl = url;
};

const fetchWithTimeout = async (url: string, init: RequestInit = {}, timeoutMs = 30_000) => {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await resilientFetch(url, { ...init, signal }, { maxAttempts: 2 });
  } catch (err) {
    throw new Error(`request failed: ${String(err)}`);
  }
};

export const fetchRepos = async () => {
  const response = await fetchWithTimeout(`${_backendUrl}/api/repos`);
  return response.json();
};

export const readFile = async (filePath: string) => {
  const params = new URLSearchParams({ path: filePath });
  const response = await fetchWithTimeout(`${_backendUrl}/api/file?${params}`);
  return response.json();
};

export const runQuery = async (cypher: string) => {
  const response = await fetchWithTimeout(`${_backendUrl}/api/query`, {
    method: 'POST',
    body: JSON.stringify({ cypher }),
  });
  return response.json();
};

export const listProcesses = async (repo?: string) => {
  const response = await fetchWithTimeout(
    `${_backendUrl}/api/processes${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`,
  );
  return response.json();
};

export const getJob = async (jobId: string) => {
  const response = await fetchWithTimeout(`${_backendUrl}/api/analyze/${jobId}`);
  return response.json();
};
