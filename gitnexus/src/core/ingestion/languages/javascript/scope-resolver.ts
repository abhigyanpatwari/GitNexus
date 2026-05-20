/**
 * JavaScript `ScopeResolver` registered in `SCOPE_RESOLVERS` and
 * consumed by the generic `runScopeResolution` orchestrator
 * (RFC #909 Ring 3, issue #928).
 *
 * Follows the same minimal wiring-only pattern as TypeScript (the third
 * migration). Per-hook logic lives in sibling modules:
 *
 *   - `query.ts`          — JS scope query + parser/query singletons
 *   - `captures.ts`       — `emitJsScopeCaptures` (JS grammar, CJS, JSDoc)
 *   - `interpret.ts`      — `interpretJsImport` (delegates to TS interpreter)
 *   - `simple-hooks.ts`   — `jsBindingScopeFor`, `jsImportOwningScope`,
 *                           `jsReceiverBinding` (all delegate to TS hooks)
 *   - `merge-bindings.ts` — `jsMergeBindings` (delegates to TS function)
 *   - `arity.ts`          — `jsArityCompatibility` (delegates to TS function)
 *   - `import-target.ts`  — `makeJsResolveImportTarget` (TS resolver, JS extensions)
 *
 * See `./index.ts` for the full per-module rationale.
 *
 * ## Key differences from TypeScript resolver
 *
 *   - `fieldFallbackOnMethodLookup: true` — JavaScript is dynamically typed;
 *     the field-fallback heuristic is ENABLED (unlike TypeScript, which
 *     disables it because the type-binding layer is precise).
 *   - `allowGlobalFreeCallFallback: true` — CJS `require` patterns and
 *     global helpers (e.g. `process`, `console`) benefit from workspace-
 *     wide unique-name fallback. TypeScript uses explicit imports.
 *   - `loadResolutionConfig` is omitted — JavaScript projects don't use
 *     `tsconfig.json` path aliases in general. `tsconfigPaths: null` is
 *     threaded through the resolver adapter.
 *   - `hoistTypeBindingsToModule: true` — JSDoc `@returns {T}` bindings are
 *     synthesized on the function scope and hoisted, matching TypeScript's
 *     method return-type hoisting strategy for cross-file chain resolution.
 */

import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { javascriptProvider } from '../typescript.js';
import { jsMergeBindings } from './merge-bindings.js';
import { jsArityCompatibility } from './arity.js';
import { makeJsResolveImportTarget } from './import-target.js';

const javascriptScopeResolver: ScopeResolver = {
  language: SupportedLanguages.JavaScript,
  languageProvider: javascriptProvider,
  importEdgeReason: 'javascript-scope: import',

  resolveImportTarget: makeJsResolveImportTarget(),

  // JavaScript LEGB — same tier ordering as TypeScript; no declaration-
  // merging across type/value/namespace spaces.
  mergeBindings: (existing, incoming) => [...jsMergeBindings([...existing, ...incoming])],

  // Adapter: jsArityCompatibility uses (def, callsite); contract is (callsite, def).
  arityCompatibility: (callsite, def) => jsArityCompatibility(def, callsite),

  buildMro: (graph, parsedFiles, nodeLookup) =>
    buildMro(graph, parsedFiles, nodeLookup, defaultLinearize),

  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),

  // JavaScript `super` keyword: same pattern as TypeScript.
  isSuperReceiver: (text) => /^super(\s*\(|\s*\.|\s*\[|\s*$)/.test(text.trim()),

  // JavaScript is dynamically typed — enable the field-fallback heuristic
  // so member-call receivers without type annotations can still resolve
  // through declared class fields (e.g. JSDoc-typed fields).
  fieldFallbackOnMethodLookup: true,

  // Return-type propagation (across ESM imports) mirrors TypeScript's
  // default behavior. JSDoc @returns bindings are hoisted to Module scope
  // and propagated to importers via the standard mechanism.
  propagatesReturnTypesAcrossImports: true,

  // JSDoc @returns bindings are synthesized on the function/method node
  // and hoisted to Module scope by `jsBindingScopeFor` (identical to the
  // TypeScript `tsBindingScopeFor` `@type-binding.return` branch).
  hoistTypeBindingsToModule: true,

  // CJS-heavy codebases often have utility functions exported without
  // explicit imports at the call site. Workspace-wide unique-name fallback
  // recovers these edges.
  allowGlobalFreeCallFallback: true,
};

export { javascriptScopeResolver };
