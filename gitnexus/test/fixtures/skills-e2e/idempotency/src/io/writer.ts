
import { log } from './logger';

export function writeFile(path: string, data: string) {
  log('writing ' + path);
  return true;
}

export function flush() {
  log('flushing');
  return true;
}
