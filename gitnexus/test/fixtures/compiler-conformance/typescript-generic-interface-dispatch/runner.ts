import type { Validator } from './validator.js';
export function run(v: Validator<string>): boolean { return v.check('x'); }
export function runAny<T>(v: Validator<T>, item: T): boolean { return v.check(item); }
