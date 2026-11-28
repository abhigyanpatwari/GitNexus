export function load(next: () => Promise<void>) {
  return next();
}
export function names(next: () => string[]) {
  return next();
}
