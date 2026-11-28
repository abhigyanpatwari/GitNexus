import * as Widget from './outer';
export function outer() { return new Widget.Widget(); }
export async function inner() {
  const Widget = await import('./inner');
  return new Widget.Widget();
}
