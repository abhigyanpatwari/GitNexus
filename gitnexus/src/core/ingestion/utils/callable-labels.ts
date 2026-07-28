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

/**
 * Labels whose FUNCTION-LOCAL declarations carry the enclosing-callable +
 * position identity of #2699 (`Function:x.ts:run.save@3:2`).
 *
 * Wider than {@link isOverloadableCallable} on purpose. #2695 restricted the
 * rule to callables because the collision that produced wrong CALLS edges was
 * between callables, and widening churned ids for symbols the local-symbol
 * pruner mostly deletes. But the issue's ORIGINAL complaint was about values:
 * a top-level `const handler` and a function-local `const handler` collapsed
 * onto one `Const:v.ts:handler`, and no callable gate ever reaches that. The
 * limitation is closed here rather than carried.
 *
 * Only LOCALS are affected either way: the prefix comes from
 * `enclosingCallablePrefix`, which returns `undefined` when nothing encloses
 * the declaration, so top-level and class-member ids are untouched — that is
 * what keeps this off the symbols other files and stored references address.
 * A class field stays unqualified even inside a function, because the prefix
 * walk boundaries on class-likes.
 *
 * ONE definition, deliberately: the id-building phase and the resolution phase
 * must agree on this set or the caller attaches to a node that does not exist
 * and the edge is silently dropped — the failure mode #2714 fixed, invisible
 * from outside because "zero dangling edges" is what it looks like.
 */
export function isPositionQualifiedLocalLabel(label: NodeLabel | undefined): boolean {
  return (
    isOverloadableCallable(label) ||
    label === 'Variable' ||
    label === 'Const' ||
    label === 'Property' ||
    label === 'Static'
  );
}
