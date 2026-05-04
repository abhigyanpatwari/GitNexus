import { Foo } from './components';

// Combined fix verification: an arrow-typed component (the HOF-callback
// fix's central case — `const fn = () => ...`) whose body returns JSX
// (the JSX-as-call fix). The HOF fix anchors the Function def on the
// inner arrow so caller-attribution lands on `Wrapped`; the JSX fix
// emits the `<Foo />` reference site as `@reference.call.free`. The
// combined effect: `Wrapped → Foo` is captured.
export const Wrapped = () => <Foo />;
