
import { parse } from './parser';
import { validate } from './validator';

export function transform(input: string) {
  validate(input);
  const tokens = parse(input);
  return tokens.map(t => t.toUpperCase());
}

export function optimize(input: string) {
  const tokens = parse(input);
  return tokens.filter(t => t.length > 0);
}
