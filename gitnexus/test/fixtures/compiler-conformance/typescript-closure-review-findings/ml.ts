function target(x: number): number { return x; }
function outer(): number {
  const single = (x: number) => target(x);
  const multi =
    (x: number) => target(x);
  return single(1) + multi(2);
}
