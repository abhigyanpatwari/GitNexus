/**
 * Zig `ScopeResolver` registered in `SCOPE_RESOLVERS` and consumed by the
 * generic `runScopeResolution` orchestrator.
 *
 * Thin wiring: Zig has no inheritance (default MRO linearization over an
 * empty heritage set), no `super`, and is statically typed (field-fallback
 * heuristic off per the contract guidance). Import resolution reuses the
 * same `resolveZigImportInternal` the legacy import-resolver config wraps,
 * with `build.zig.zon` `.path` deps threaded through `loadResolutionConfig`.
 */

import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { loadZigBuildConfig, type ZigBuildZonConfig } from '../../language-config.js';
import { resolveZigImportInternal } from '../../import-resolvers/zig.js';
import { zigProvider } from '../zig.js';
import { expandZigWildcardNames, zigArityCompatibility, zigMergeBindings } from './index.js';
import { populateZigRangeBindings } from './range-binding.js';

export const zigScopeResolver: ScopeResolver = {
  language: SupportedLanguages.Zig,
  languageProvider: zigProvider,
  importEdgeReason: 'zig-scope: import',
  // A struct literal `T{ .f = x }` is a CALLS edge to the Struct node (the
  // Rust `T { .. }` / Go `T{}` shape). Zig has no Constructor nodes, so
  // nothing but this marker tells that edge from an invocation on the edge
  // itself — `main → SpawnRequest` looked like a call to a function
  // (PR #1432 review). Emits `local-call (constructor)` and friends.
  markConstructionSites: true,
  // Hub modules are how Zig projects publish their types: `pub const Terminal
  // = @import("Terminal.zig");` / `pub const PRNG = @import("prng.zig");` in a
  // file that declares nothing itself. Consumers then write
  // `terminal.Terminal.init()`, `stdx.PRNG.from_seed()`, `t: stdx.Thing`.
  // Measured on real projects before → after this flag: CALLS into ghostty's
  // `src/terminal/` from outside it 46 → 253; into tigerbeetle's `stdx` hub
  // from outside it 837 → 1500 (136 `stdx.Type.fn(` sites, 289 annotations).
  namespaceExportsIncludeImportedNames: true,

  loadResolutionConfig: (repoPath: string) => loadZigBuildConfig(repoPath),

  resolveImportTarget: (targetRaw, fromFile, allFilePaths, resolutionConfig) =>
    resolveZigImportInternal(
      fromFile,
      targetRaw,
      allFilePaths,
      (resolutionConfig as ZigBuildZonConfig | null | undefined) ?? null,
    ),

  // `pub usingnamespace @import("x.zig");` — target decls become local decls.
  expandsWildcardTo: (targetModuleScope, parsedFiles) =>
    expandZigWildcardNames(targetModuleScope, parsedFiles),

  mergeBindings: zigMergeBindings,
  arityCompatibility: zigArityCompatibility,

  buildMro: (graph, parsedFiles, nodeLookup) =>
    buildMro(graph, parsedFiles, nodeLookup, defaultLinearize),

  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),

  // Payload captures — `for (items) |it|`, `if (opt) |v|`, `while (it.next())
  // |x|` — typed from the subject's binding after finalize (F6).
  populateRangeBindings: populateZigRangeBindings,

  // Zig has no `super`.
  isSuperReceiver: () => false,

  // Statically typed — the field-fallback heuristic over-connects.
  fieldFallbackOnMethodLookup: false,
};
