/**
 * Go's answer to `ScopeResolver.isNamespaceMemberVisible`.
 *
 * A namespace-qualified reference (`api.Target()`, `x: api.Thing`) always
 * crosses a package boundary: a package cannot import itself, and a `_test`
 * external package is a different package from the one under test. Across that
 * boundary Go exports an identifier only when it begins with a Unicode
 * uppercase letter, so `api.target` names nothing no matter which import
 * spelling (plain, alias, or the package's own `_test` twin) introduced `api`.
 *
 * The shared namespace lookups know nothing of that rule: they treat every
 * module-scope binding of the target package as a member. Without this hook
 * `api.target()` in invalid code resolves at `import-resolved` confidence, and
 * a rename that unexports `api.Target` re-resolves the now-lowercase call back
 * to the same declaration and certifies a program that no longer compiles.
 *
 * Same-package access never reaches this hook: bare names come from the
 * package-sibling and dot-import channels, which decide their own visibility.
 * Methods and fields are not module-scope bindings and are not consulted.
 */

import type { SymbolDefinition } from 'gitnexus-shared';
import { goSimpleName, isExportedGoName } from './name-fallback-visibility.js';

export function goIsNamespaceMemberVisible(ctx: { readonly member: SymbolDefinition }): boolean {
  const simpleName = goSimpleName(ctx.member);
  // No identifier to read the case of is an unanswered question, not a refusal.
  return simpleName === '' || isExportedGoName(simpleName);
}
