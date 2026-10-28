import { request } from './desktop-ipc';

export function openPage(path: string) {
  return request(path);
}

openPage('/settings');
// A literal call to the imported IPC request(), not to the fetch wrapper of the same name.
request('/settings');
