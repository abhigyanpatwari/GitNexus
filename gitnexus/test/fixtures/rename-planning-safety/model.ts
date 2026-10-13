export function target() {
  return 1;
}

export function caller() {
  return target();
}
