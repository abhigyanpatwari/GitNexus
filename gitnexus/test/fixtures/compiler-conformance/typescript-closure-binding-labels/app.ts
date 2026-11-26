const handler = (x: number) => x;

export function caller(): number {
  return handler(1);
}
