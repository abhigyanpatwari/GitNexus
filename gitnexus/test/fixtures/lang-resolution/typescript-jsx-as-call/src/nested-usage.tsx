import { Inner, Outer } from './components';

// Nested JSX — `<Outer><Inner /></Outer>`. Both `<Outer>` (paired) and
// `<Inner />` (self-closing) are reference sites for the same enclosing
// caller (`useNested`). Should emit TWO CALLS edges from `useNested`:
//
//   useNested → Outer
//   useNested → Inner
export const useNested = () => (
  <Outer>
    <Inner />
  </Outer>
);
