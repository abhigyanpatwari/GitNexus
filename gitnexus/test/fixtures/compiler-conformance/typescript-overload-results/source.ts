export class Source {
  lookup(value: string): number;
  lookup(value: number): string;
  lookup(value: string | number): number | string {
    return typeof value === 'number' ? String(value) : value.length;
  }
}
