import type { SyntaxNode } from '../../utils/ast-helpers.js';

/**
 * Trailing simple-name `type_identifier` of a Swift `user_type` base. A
 * qualified `Outer.Inner` parses flat as
 * `(user_type (type_identifier "Outer") (type_identifier "Inner"))`, and the
 * actual base type is the TRAILING segment `Inner` (mirrors Java
 * `scoped_type_identifier` → `lastNamedChild` and TS `nested_type_identifier`
 * → tail). Generic arguments live in a sibling `type_arguments` node — never a
 * `type_identifier` — so they are skipped: `Box<Int>` → `Box`,
 * `Outer.Inner<T>` → `Inner`. Returns null when the `user_type` has no
 * `type_identifier` child.
 *
 * Shared by `swiftBaseTypeIdentifier` (captures.ts — returns the node for an
 * `@reference.inherits` site) and `firstInheritedType` (receiver-binding.ts —
 * reads `.text` for `super` receiver binding). It lives in this leaf module
 * rather than being exported from captures.ts because captures.ts already
 * imports receiver-binding.ts, so a captures.ts export would create a
 * bidirectional import cycle (#1956 tri-review U7).
 */
export function swiftQualifiedBaseTail(userType: SyntaxNode): SyntaxNode | null {
  let last: SyntaxNode | null = null;
  for (let i = 0; i < userType.namedChildCount; i++) {
    const child = userType.namedChild(i);
    if (child !== null && child.type === 'type_identifier') last = child;
  }
  return last;
}
