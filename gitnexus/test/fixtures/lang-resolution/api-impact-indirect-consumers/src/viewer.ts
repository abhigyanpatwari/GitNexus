import { fetchFile } from './client';

export function openFile(path: string) {
  return fetchFile(path);
}
