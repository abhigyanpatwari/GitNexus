export function helper(): number { return 1; }
export class T {
  m(): number { return helper(); }
}
export function top(): number { return helper(); }
