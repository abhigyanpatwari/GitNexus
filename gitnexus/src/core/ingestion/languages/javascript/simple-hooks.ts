/**
 * Simple hooks for the JavaScript scope-resolution provider.
 *
 * All three hooks delegate to their TypeScript counterparts because
 * JavaScript shares the same semantics:
 *
 *   - `bindingScopeFor` — `var` hoists to enclosing Function/Module;
 *     `let`/`const` are block-scoped. Identical to TypeScript.
 *   - `importOwningScope` — ESM imports are top-level; null = default
 *     (walk to nearest Module). Same for JavaScript.
 *   - `receiverBinding` — look up `this` on the function scope's
 *     type bindings, populated by `synthesizeTsReceiverBinding` in
 *     `captures.ts`. Identical semantics to TypeScript.
 */

export {
  tsBindingScopeFor as jsBindingScopeFor,
  tsImportOwningScope as jsImportOwningScope,
  tsReceiverBinding as jsReceiverBinding,
} from '../typescript/simple-hooks.js';
