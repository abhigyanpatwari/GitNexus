export function run(): number {
  const pick =
    (x: number): number => x * 2;
  return pick(1);
}
export function other(): number {
  const pick =
    (x: number): number => x * 3;
  return pick(2);
}
