import { find as lookup } from './service.js';
import viaDefault, { renamed as viaBarrel } from './barrel.js';

export function numericBarrel() { return viaBarrel(42); }
export function textualDefault() { return viaDefault('alice'); }

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
