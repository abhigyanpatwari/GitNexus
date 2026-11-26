const g = function* (x: number) {
  yield x;
};

export function caller() {
  return g(1);
}
