function make() { return () => 1; }
class Deferred {
  // @ts-expect-error The emitted JavaScript allows reassignment during construction.
  field = (make = () => () => 3);
}
void 0;
export default make();
// @ts-expect-error The emitted JavaScript permits reassigning the function.
make = () => () => 2;
