import type { Validator } from './validator.js';
export class NumberValidator implements Validator<number> {
  check(item: number): boolean { return true; }
}
