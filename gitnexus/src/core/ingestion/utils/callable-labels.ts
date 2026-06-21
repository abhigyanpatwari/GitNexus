import type { NodeLabel } from 'gitnexus-shared';

/**
 * Callables whose same-name overloads occupy distinct graph nodes keyed by
 * parameter types / shape. Shared by graph-bridge registration (`node-lookup.ts`)
 * and resolution (`ids.ts`) so overload keys stay aligned.
 *
 * Constructors belong here: a class with `Foo()` and `Foo(int)` mints distinct
 * `#0`/`#1` Constructor nodes, and a `: this(...)` / `: base(...)` (C#),
 * `this(...)`/`super(...)` (Java), or `new Foo(args)` edge must reach the
 * right overload — otherwise both ctor nodes collapse onto the first-wins
 * qualified/simple key and a ctor chain becomes a self-loop (#1928 F38 / #2046).
 */
export function isOverloadableCallable(label: NodeLabel | undefined): boolean {
  return label === 'Function' || label === 'Method' || label === 'Constructor';
}
