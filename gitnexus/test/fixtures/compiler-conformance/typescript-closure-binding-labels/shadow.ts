export function handler(x: number): number {
  return x;
}
export function other(x: number): number {
  return x * 2;
}

export function caller(): number {
  const handler = other;
  return handler(1);
}
