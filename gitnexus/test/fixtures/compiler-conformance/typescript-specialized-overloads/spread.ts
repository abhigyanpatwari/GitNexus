function join(value: string): number;
function join(value: number, suffix: string): string;
function join(value: number | string, suffix?: string) {
  return typeof value === 'number' ? suffix! : value.length;
}

function write(head: boolean, ...rest: [number, string, boolean]): string;
function write(head: boolean, tail: boolean): number;
function write(head: boolean, ...rest: unknown[]) {
  return rest.length === 1 ? Number(head) : String(head);
}

export function expanded(pair: readonly [number, string], empty: []) {
  join(...pair);
  join(...empty, 'only');
  write(true, ...pair, false);
  write(true, ...empty, false);
}

function group(...pairs: [number, string][]): 'array';
function group(number: number, text: string): 'pair';
function group(...items: unknown[]): 'array' | 'pair' {
  return items.length === 2 ? 'pair' : 'array';
}

export function groupPairs(pair: [number, string]) {
  group(1, 'x');
  group(...pair);
  group();
}
