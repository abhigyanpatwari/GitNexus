/**
 * Java `ScopeResolver` registered in `SCOPE_RESOLVERS` and consumed by
 * the generic `runScopeResolution` orchestrator (RFC #909 Ring 3).
 *
 * ## Registry-primary parity status
 *
 * Java is **not** in `MIGRATED_LANGUAGES` — the scope-resolution
 * registry runs in shadow mode only.  Parity in forced registry mode
 * (`REGISTRY_PRIMARY_JAVA=1`) is 143/172 (83%).  The 29 gaps fall into:
 *
 *   - switch pattern binding / sealed-class exhaustiveness
 *   - Map.values() / entrySet() iteration type propagation
 *   - assignment / method chain return-type propagation across files
 *   - virtual dispatch / interface default methods
 *
 * These are the same category of advanced-resolution gaps seen in prior
 * migrations (Python, C#, Go).  Parity is below the ≥99% flip threshold
 * per RFC §6.4.
 *
 * **CI visibility:** Because Java is absent from `MIGRATED_LANGUAGES`,
 * the parity CI workflow (`ci-scope-parity.yml`) does not run Java in
 * either `REGISTRY_PRIMARY_JAVA=0` or `=1` mode.  Regressions in forced
 * mode are only visible via manual `REGISTRY_PRIMARY_JAVA=1 npx vitest
 * run java.test.ts`.  Before flipping Java to registry-primary, a
 * non-required CI step should be added to run Java tests in forced mode
 * and report parity as a dashboard input.
 *
 * **Parity baseline (29 failures):** The 29 gaps in forced registry mode
 * are tracked in this PR (#1482) and this JSDoc.  If the gap count
 * changes (up or down), update this baseline accordingly.
 *
 * ### Known flip-blockers (must fix before adding to MIGRATED_LANGUAGES)
 *
 *   - Varargs arity: fixed-prefix count is now preserved, but no
 *     integration fixture exercises the 0-arg rejection path yet.
 *   - Static import resolution: `import static X.Y.m` now correctly
 *     resolves to `X/Y.java` (the class), not `X/Y/m.java` (the member).
 *     Edge cases with nested classes may remain.
 *   - Generic superclass receiver binding: `BaseModel<T>` now strips
 *     to `BaseModel` via JVM type-erasure fallback in `stripGeneric`.
 *   - Wildcard import (`import com.example.*`) file selection is
 *     nondeterministic when multiple classes share a package directory.
 *     May produce wrong-file edges in forced mode.
 *   - Qualified generic type parameters in field/parameter annotations
 *     (`com.example.BaseModel<T>`) — rare in practice but may miss
 *     resolution when the full qualifier is present with generics.
 */

import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { javaProvider } from '../java.js';
import {
  javaArityCompatibility,
  javaMergeBindings,
  resolveJavaImportTarget,
  type JavaResolveContext,
} from './index.js';

const javaScopeResolver: ScopeResolver = {
  language: SupportedLanguages.Java,
  languageProvider: javaProvider,
  importEdgeReason: 'java-scope: import',

  resolveImportTarget: (targetRaw, fromFile, allFilePaths) => {
    const ws: JavaResolveContext = { fromFile, allFilePaths };
    return resolveJavaImportTarget(
      { kind: 'named', localName: '_', importedName: '_', targetRaw },
      ws,
    );
  },

  mergeBindings: (existing, incoming) => [...javaMergeBindings([...existing, ...incoming])],

  arityCompatibility: (callsite, def) => javaArityCompatibility(def, callsite),

  buildMro: (graph, parsedFiles, nodeLookup) =>
    buildMro(graph, parsedFiles, nodeLookup, defaultLinearize),

  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),

  isSuperReceiver: (text) => text.trim() === 'super',

  // Java is statically typed — field-fallback heuristic stays off
  fieldFallbackOnMethodLookup: false,
  propagatesReturnTypesAcrossImports: true,

  // Java doesn't collapse member calls
  collapseMemberCallsByCallerTarget: false,

  // Hoist return-type bindings to Module scope for cross-file propagation
  hoistTypeBindingsToModule: true,
};

export { javaScopeResolver };
