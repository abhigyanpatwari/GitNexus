import { find as lookup } from './service.js';

export function numeric() {
  return lookup(42);
}

export function textual() {
  return lookup('alice');
}

export function local() {
  function lookup(key: string) { return key.length; }
  return lookup('alice');
}
