import { Foo } from './components';

// Self-closing JSX element — the most common React-component invocation
// shape. Should emit `useFoo → Foo` as a CALLS edge.
export const useFoo = () => <Foo />;
