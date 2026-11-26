function make() { return () => 1; }
void 0;
export default make();
// @ts-expect-error The emitted JavaScript permits reassigning the function.
make = () => () => 2;
