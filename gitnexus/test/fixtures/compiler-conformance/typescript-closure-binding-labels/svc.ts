export class Svc {
  save(x: number): number {
    return x;
  }
}

export function run(): number {
  const save = (x: number): number => x * 2;
  return save(1);
}
