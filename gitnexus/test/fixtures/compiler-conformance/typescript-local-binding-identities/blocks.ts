export function outer(a: boolean): number {
  if (a) {
    const pick = (x: number) => x * 2;
    return pick(1);
  } else {
    const pick = (x: number) => x * 3;
    return pick(2);
  }
}
