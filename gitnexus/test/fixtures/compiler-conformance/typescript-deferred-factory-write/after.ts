function make() { return () => 1; }
class Deferred {
  // @ts-expect-error The emitted JavaScript allows reassignment during construction.
  field = (make = () => () => 3);
}
function evaluateLater() { eval('new Deferred()'); }
export default make();
eval('new Deferred()');
// @ts-expect-error The emitted JavaScript permits reassigning the function.
make = () => () => 2;
