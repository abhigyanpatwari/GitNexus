export function find(key: number): number;
export function find(key: string): string;
export function find(key: number | string): number | string {
  return key;
}
