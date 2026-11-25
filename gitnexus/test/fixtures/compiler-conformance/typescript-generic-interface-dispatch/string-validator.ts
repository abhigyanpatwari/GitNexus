import type { Validator } from './validator.js';
export class StringValidator implements Validator<string> {
  check(item: string): boolean { return true; }
}
