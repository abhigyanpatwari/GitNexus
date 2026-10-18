import { request } from './desktop-ipc';

export function openPage(path: string) {
  return request(path);
}

openPage('/settings');
