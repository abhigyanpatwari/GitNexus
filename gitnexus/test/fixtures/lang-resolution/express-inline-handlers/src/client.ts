import { request } from 'http-client';

// `request` is not proven to send HTTP requests: a possible consumer only.
export const listRepos = () => request('/api/repos');
