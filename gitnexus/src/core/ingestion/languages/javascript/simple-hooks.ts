/**
 * Simple hooks for the JavaScript scope-resolution provider.
 *
 * `jsBindingScopeFor` wraps `tsBindingScopeFor` and adds the JS-only
 * `@type-binding.class-field` hoisting rule.  The other two hooks
 * (`jsImportOwningScope`, `jsReceiverBinding`) are identical to their
 * TypeScript counterparts and are re-exported directly.
 *
 * ## Why class-field hoisting lives here (not in `tsBindingScopeFor`)
 *
 * `@type-binding.class-field` is emitted exclusively by
 * `synthesizeConstructorFieldBindings` in `captures.ts`, which is a
 * JavaScript-only synthesis pass.  TypeScript uses
 * `@type-binding.parameter-property` for constructor parameter
 * properties instead.  Keeping the JS-only rule in the JS hook file
 * prevents language-specific logic from leaking into shared TypeScript
 * infrastructure (DoD.md §2.2).
 */

import type { CaptureMatch, Scope, ScopeId, ScopeTree } from 'gitnexus-shared';
import { tsBindingScopeFor, walkToScope } from '../typescript/simple-hooks.js';

export {
  tsImportOwningScope as jsImportOwningScope,
  tsReceiverBinding as jsReceiverBinding,
} from '../typescript/simple-hooks.js';

/**
 * Like `tsBindingScopeFor` but additionally hoists
 * `@type-binding.class-field` captures to the enclosing Class scope.
 *
 * `@type-binding.class-field` is anchored inside the constructor body
 * (by `synthesizeConstructorFieldBindings`) so that `walkToScope` can
 * walk up from the Function (constructor) scope to the Class scope.
 * This puts `User.address → Address` in the class's typeBindings so
 * compound-receiver resolution finds it when resolving
 * `user.address.save()`.
 */
export function jsBindingScopeFor(
  decl: CaptureMatch,
  innermost: Scope,
  tree: ScopeTree,
): ScopeId | null {
  if (decl['@type-binding.class-field'] !== undefined) {
    return walkToScope(innermost, tree, 'Class');
  }
  return tsBindingScopeFor(decl, innermost, tree);
}
