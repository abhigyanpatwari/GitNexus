export function outer() {
  return function () {
    const save = (x: number) => x * 2;
    return save(1);
  };
}
export function save(x: number) { return x; }
