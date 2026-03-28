
import { readFile } from '../io/reader';
import { log } from '../io/logger';

export function parse(input: string) {
  const data = readFile(input);
  log('parsing');
  return tokenize(data);
}

export function tokenize(data: string) {
  log('tokenizing');
  return data.split(' ');
}
