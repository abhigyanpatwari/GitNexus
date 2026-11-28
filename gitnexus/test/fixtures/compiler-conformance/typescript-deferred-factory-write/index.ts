function make() { return () => 1; }
const unrelated = 1;
void eval;
export default make();
export function later() {
  // @ts-expect-error Function declarations can be reassigned by emitted JavaScript.
  make = () => () => 2;
}
