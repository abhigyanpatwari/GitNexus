import { AmbientBase, Inside, Nested } from './ambient';
export function read(base: AmbientBase, inside: Inside, nested: Nested) {
  return base.method();
}
