function make() { return () => 1; }

export default make();

export function record(values: Record<string, number>) {
  values[make.name] = 1;
}

export function resetLocal() {
  let make = 0;
  make = 1;
  return make;
}
