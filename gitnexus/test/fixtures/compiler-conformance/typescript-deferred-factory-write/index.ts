function make() { return () => 1; }
export default make();
export function later() {
  // @ts-expect-error Function declarations can be reassigned by emitted JavaScript.
  make = () => () => 2;
}
