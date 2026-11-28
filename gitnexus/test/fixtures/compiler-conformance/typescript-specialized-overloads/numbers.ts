export function choose(value: -1): 'negative';
export function choose(value: number): 'other';
export function choose(value: number) { return value === -1 ? 'negative' : 'other'; }

export function useNumbers() {
  choose(-1);
  choose(- /* sign belongs to the expression */ 0x1);
  choose(-2);
  choose(+2);
}
