function select(first, second: string): string;
function select(first, second: number): number;
function select(first: boolean, second: boolean): boolean;
function select(first, second) { return second; }

export function calls() {
  select('decoy', 1);
  select(1, 'text');
  select(true, false);
}
