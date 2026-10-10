/**
 * Trivial / no-op-ish hooks for the TypeScript provider. Kept together
 * because each is a few lines and they share a common theme: making
 * the provider's choice explicit rather than relying on "absence ==
 * default" so reviewers don't have to re-derive the analysis.
 */

import type {
  CaptureMatch,
  ParsedImport,
  Scope,
  ScopeId,
  ScopeTree,
  TypeRef,
} from 'gitnexus-shared';
import { walkToScope } from '../../utils/scope-tree-walk.js';

// ─── bindingScopeFor ──────────────────────────────────────────────────────

/**
 * TypeScript/JavaScript has block-scoped `let`/`const` (the innermost
 * default covers these) but function-scoped `var` — which hoists to
 * the enclosing **function or module** scope, bypassing intermediate
 * blocks. JS also function-hoists `function_declaration` to the same
 * level.
 *
 * We distinguish var from let/const by sniffing the `@declaration.variable`
 * capture's leading keyword. The capture's text begins with the
 * source-literal keyword (`var ` / `let ` / `const `) because the
 * anchor is the outer `lexical_declaration` / `variable_declaration`
 * node — there's no whitespace before the keyword in any well-formed
 * TS/JS source.
 *
 * Additionally hoists **method return-type bindings**
 * (`@type-binding.return`) all the way to the Module scope, matching
 * C#: the compound-receiver walker and `propagateImportedReturnTypes`
 * both read from module-level typeBindings for cross-file chain
 * propagation.
 */
export function tsBindingScopeFor(
  decl: CaptureMatch,
  innermost: Scope,
  tree: ScopeTree,
): ScopeId | null {
  // Method return type: hoist to Module (mirrors csharpBindingScopeFor).
  if (decl['@type-binding.return'] !== undefined) {
    return walkToScope(innermost, tree, 'Module');
  }

  // Parameter property (`constructor(public address: Address)`): hoist
  // to the enclosing Class scope so `user.address` field access
  // resolves through the class's typeBindings. The regular
  // @type-binding.parameter binding still fires for the constructor
  // scope; this one adds a second binding on the class.
  if (decl['@type-binding.parameter-property'] !== undefined) {
    return walkToScope(innermost, tree, 'Class');
  }

  // JSDoc parameters are anchored on the whole function, unlike inline
  // parameter annotations. They still belong to its body, not its parent.
  if (decl['@type-binding.parameter'] !== undefined) {
    return walkToScope(innermost, tree, 'Function');
  }

  // A for-of alias covers the whole loop. When that loop introduces a lexical
  // block, its element type belongs beside the loop variable's name claim.
  // Returning the owner explicitly prevents equal-range auto-hoisting.
  const alias = decl['@type-binding.alias'];
  if (
    alias !== undefined &&
    innermost.kind === 'Block' &&
    alias.range.startLine === innermost.range.startLine &&
    alias.range.startCol === innermost.range.startCol &&
    alias.range.endLine === innermost.range.endLine &&
    alias.range.endCol === innermost.range.endCol
  )
    return innermost.id;

  // `this.p = new Outer()` binds the FIELD, not a method-local, so the binding
  // belongs on the class the way an annotated field's does — that is the only
  // place `typeOfMemberOnClass` reads. Left on the innermost scope it would sit
  // on the method's own Function scope and never be found (#2807). Same shape
  // as the parameter-property branch above.
  //
  // Gated on the marker the `this.<field> = new …` pattern emits, never on
  // `@type-binding.constructor` at large: that capture also fires for
  // `const o = new Outer()` inside a method, and hoisting THOSE to the class
  // would take method locals out of their own scope and mistype them.
  //
  // This walk is UNCONDITIONAL by design, and stays correct only because the
  // marker's producers are bounded: the query nests the pattern under
  // `class_body → method_definition → statement_block`, and `emitTsScopeCaptures`
  // drops the static-method case. So `this` here provably IS an instance of the
  // class this lands on, and a Class ancestor always exists — no `walkToScope`
  // null-fallback onto some unrelated innermost scope. Anything that widens the
  // marker's producers has to re-establish both, or restore the guard here.
  if (decl['@type-binding.this-field'] !== undefined) {
    return walkToScope(innermost, tree, 'Class');
  }

  // `var` declarations: hoist to nearest enclosing Function or Module.
  const variable = decl['@declaration.variable'];
  if (variable !== undefined && isVarDeclaration(variable.text)) {
    return walkToScope(innermost, tree, 'Function', 'Module');
  }

  // Function declarations are already anchored at their definition
  // site via `@scope.function`; hoisting is a no-op for them (JS
  // function hoisting is about visibility before the definition, not
  // about placing the binding in a different scope). The scope tree
  // already attaches their name to the enclosing scope. No override
  // needed.
  return null;
}

/** `var x = 1;` vs `let x = 1;` / `const x = 1;`. The capture's text
 *  starts at the outer declaration's `startIndex` in source, which is
 *  the keyword's first character — no leading whitespace possible. */
function isVarDeclaration(captureText: string): boolean {
  return (
    captureText.startsWith('var ') ||
    captureText.startsWith('var\t') ||
    captureText.startsWith('var\n')
  );
}

// ─── importOwningScope ────────────────────────────────────────────────────

/**
 * Static external imports belong to the module. Local require/await-import
 * captures carry an explicit declaredAtScope from their binding declaration:
 * var hoists to a function, while let/const remain in their lexical block.
 * The extractor honors that explicit owner before consulting this hook.
 * Returning null leaves other imports at their syntactic scope.
 */
export function tsImportOwningScope(
  _imp: ParsedImport,
  _innermost: Scope,
  _tree: ScopeTree,
): ScopeId | null {
  return null;
}

// ─── receiverBinding ──────────────────────────────────────────────────────

/**
 * Look up `this` on the function scope's type bindings.
 *
 * `this` is synthesized as a type binding on instance-method function
 * scopes during capture emission (`receiver-binding.ts`). Arrow
 * functions and nested functions that reference `this` naturally
 * resolve it via the scope-chain walk — if the arrow function is a
 * class method (`m = () => {}`), it gets a synthesized `this`; if it
 * is nested inside a class method, the scope-chain lookup finds the
 * outer method's `this`. This mirrors TypeScript's lexical-this
 * semantics for arrow functions.
 *
 * Returns `null` for:
 *   - static methods (no `this` synthesized)
 *   - free functions / module-level code (no enclosing class-like)
 *   - non-Function scopes
 *
 * Caveat: a non-arrow `function` declaration nested inside a method
 * DOES see the outer `this` via our scope-chain lookup, even though at
 * runtime its `this` is independently bound (strict-mode `undefined`,
 * sloppy `globalThis`). We accept this false-positive — the real-world
 * pattern that relies on independent `this` inside a nested regular
 * function inside a class method is extremely rare, and catching it
 * would require injecting a `this: undefined` shadow on every non-
 * arrow function scope. Documented as a known limitation in
 * `index.ts`.
 */
export function tsReceiverBinding(functionScope: Scope): TypeRef | null {
  if (functionScope.kind !== 'Function') return null;
  return functionScope.typeBindings.get('this') ?? null;
}
