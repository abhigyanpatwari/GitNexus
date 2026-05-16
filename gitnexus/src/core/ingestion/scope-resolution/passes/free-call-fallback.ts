/**
 * Emit CALLS edges for free-call reference sites whose target is
 * imported (or otherwise visible only via post-finalize scope.bindings).
 *
 * The shared `MethodRegistry.lookup` only consults `scope.bindings`
 * (pre-finalize / local-only) for free calls. Cross-file imports land
 * in `indexes.bindings` (post-finalize). Without this fallback, every
 * `from x import f; f()` resolves to "unresolved".
 *
 * **Free-call dedup contract (Contract Invariant I2):** free calls
 * collapse to one CALLS edge per (caller, target) pair regardless of
 * how many call sites the caller contains. Mirrors the legacy DAG's
 * dedup semantics (what the `default-params` / `variadic` / `overload`
 * fixtures expect). Member calls keep position-based dedup elsewhere.
 *
 * Generic; promoted from `languages/python/scope-resolver.ts` per the scope-resolution
 * generalization plan.
 */

import type { ParsedFile, Reference, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { SemanticModel } from '../../model/semantic-model.js';
import type { WorkspaceResolutionIndex } from '../workspace-index.js';
import type { GraphNodeLookup } from '../graph-bridge/node-lookup.js';
import { resolveCallerGraphId, resolveDefGraphId } from '../graph-bridge/ids.js';
import {
  findCallableBindingInScope,
  findCallableBindingsAndAdlBlocker,
  findClassBindingInScope,
} from '../scope/walkers.js';
import {
  isOverloadAmbiguousAfterNormalization,
  narrowOverloadCandidates,
} from './overload-narrowing.js';

export function emitFreeCallFallback(
  graph: KnowledgeGraph,
  scopes: ScopeResolutionIndexes,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
  _referenceIndex: { readonly bySourceScope: ReadonlyMap<ScopeId, readonly Reference[]> },
  handledSites: Set<string>,
  model: SemanticModel,
  workspaceIndex: WorkspaceResolutionIndex,
  options: {
    readonly allowGlobalFallback?: boolean;
    readonly isFileLocalDef?: (def: SymbolDefinition) => boolean;
    readonly isCallableVisibleFromCaller?: (ctx: {
      readonly callerParsed: ParsedFile;
      readonly candidate: SymbolDefinition;
      readonly callerScope?: ScopeId;
      readonly scopes?: ScopeResolutionIndexes;
    }) => boolean;
    readonly resolveAdlCandidates?: (
      site: {
        readonly name: string;
        readonly arity?: number;
        readonly argumentTypes?: readonly string[];
        readonly atRange: { readonly startLine: number; readonly startCol: number };
      },
      callerParsed: ParsedFile,
      scopes: ScopeResolutionIndexes,
      parsedFiles: readonly ParsedFile[],
    ) => readonly SymbolDefinition[] | undefined;
  } = {},
): number {
  let emitted = 0;
  const seen = new Set<string>();

  for (const parsed of parsedFiles) {
    for (const site of parsed.referenceSites) {
      if (site.kind !== 'call') continue;
      if (site.explicitReceiver !== undefined) continue;

      // Constructor form (`new User(...)`): resolve the class, then
      // emit CALLS to its explicit Constructor def (when present) or
      // to the Class node itself (implicit constructor). Legacy emits
      // the same two targets; see test expectations.
      let fnDef: SymbolDefinition | undefined;
      if (site.callForm === 'constructor') {
        const classDef = findClassBindingInScope(site.inScope, site.name, scopes);
        if (classDef !== undefined) {
          fnDef = pickConstructorOrClass(classDef, workspaceIndex);
        }
      }
      // Implicit-this overload narrowing: an unqualified call inside
      // a method body might be calling a sibling overload on the
      // enclosing class. When the workspace has multiple methods of
      // the same name in a single class, choose the best match by
      // arity + argument types.
      if (fnDef === undefined) {
        fnDef = pickImplicitThisOverload(site, scopes, workspaceIndex, model);
      }
      if (fnDef === undefined) {
        if (options.resolveAdlCandidates === undefined) {
          fnDef = findCallableBindingInScope(site.inScope, site.name, scopes);
        } else {
          // ISO C++ `[basic.lookup.unqual]` §7: ADL is suppressed when
          // ordinary lookup finds a non-function name (variable, class, enum)
          // or a block-scope function declaration (not via using-declaration)
          // at the nearest scope where the name exists.
          const {
            callables: ordinary,
            nonCallableFound,
            blockScopeDeclFound,
          } = findCallableBindingsAndAdlBlocker(site.inScope, site.name, scopes);
          const adlSuppressed = nonCallableFound || blockScopeDeclFound;
          const adl = adlSuppressed
            ? undefined
            : options.resolveAdlCandidates(
                {
                  name: site.name,
                  arity: site.arity,
                  argumentTypes: site.argumentTypes,
                  atRange: { startLine: site.atRange.startLine, startCol: site.atRange.startCol },
                },
                parsed,
                scopes,
                parsedFiles,
              );

          // Preserve existing ordinary-lookup behavior when ADL contributed
          // no candidates.
          if (adl === undefined || adl.length === 0) {
            fnDef = ordinary[0];
          } else {
            const siteKey = `${parsed.filePath}:${site.atRange.startLine}:${site.atRange.startCol}`;
            const merged: SymbolDefinition[] = [];
            const seen = new Set<string>();
            const push = (defs: readonly SymbolDefinition[]): void => {
              for (const d of defs) {
                if (seen.has(d.nodeId)) continue;
                seen.add(d.nodeId);
                merged.push(d);
              }
            };
            push(ordinary);
            push(adl);

            const narrowed = narrowOverloadCandidates(merged, site.arity, site.argumentTypes);
            if (narrowed.length === 1) {
              fnDef = narrowed[0];
            } else if (narrowed.length === 0) {
              // ADL contributed candidates, but none survived arity/type
              // narrowing. Treat as handled to avoid global-name fallback
              // binding to the same mismatched symbol by simple-name
              // uniqueness.
              handledSites.add(siteKey);
              continue;
            } else if (narrowed.length > 1) {
              // Suppress ambiguous overload calls (emit zero edges) when
              // merged ordinary+ADL candidate sets cannot be disambiguated.
              if (isOverloadAmbiguousAfterNormalization(narrowed, site.arity)) {
                handledSites.add(siteKey);
                continue;
              }
              // Multiple survivors remain but no conversion-ranking step
              // exists yet; suppress instead of picking arbitrarily.
              handledSites.add(siteKey);
              continue;
            }
          }
        }
      }
      // V1: pickUniqueGlobalCallable ignores import context — resolves to any
      // globally-unique callable. False cross-package edges are possible when
      // the caller does not import the target package. Same-package calls are
      // usually caught by nearest-scope lookup before reaching here.
      if (fnDef === undefined && options.allowGlobalFallback === true) {
        fnDef = pickUniqueGlobalCallable(
          site.name,
          model,
          scopes,
          parsed.filePath,
          options.isFileLocalDef,
          site.arity,
          options.isCallableVisibleFromCaller !== undefined
            ? (candidate) =>
                options.isCallableVisibleFromCaller!({
                  callerParsed: parsed,
                  candidate,
                  callerScope: site.inScope,
                  scopes,
                })
            : undefined,
        );
      }
      if (fnDef === undefined) continue;
      const callerGraphId = resolveCallerGraphId(site.inScope, scopes, nodeLookup);
      if (callerGraphId === undefined) continue;
      const tgtGraphId = resolveDefGraphId(fnDef.filePath, fnDef, nodeLookup);
      if (tgtGraphId === undefined) continue;
      // Always mark the site as handled — even when the dedup-collapse
      // means we don't add a new edge — so `emit-references` skips its
      // potentially-wrong fallback for the same site.
      handledSites.add(`${parsed.filePath}:${site.atRange.startLine}:${site.atRange.startCol}`);
      const relId = `rel:CALLS:${callerGraphId}->${tgtGraphId}`;
      if (seen.has(relId)) continue;
      seen.add(relId);
      graph.addRelationship({
        id: relId,
        sourceId: callerGraphId,
        targetId: tgtGraphId,
        type: 'CALLS',
        confidence: 0.85,
        // Match legacy DAG's reason convention so consumers that
        // assert `reason === 'import-resolved'` keep working.
        reason: fnDef.filePath !== parsed.filePath ? 'import-resolved' : 'local-call',
      });
      emitted++;
    }
  }
  return emitted;
}

function pickUniqueGlobalCallable(
  name: string,
  model: SemanticModel,
  scopes: ScopeResolutionIndexes,
  callerFilePath: string,
  isFileLocalDef?: (def: SymbolDefinition) => boolean,
  callArity?: number,
  isCallerVisible?: (candidate: SymbolDefinition) => boolean,
): SymbolDefinition | undefined {
  const scopeDefs: SymbolDefinition[] = [];
  const scopeSeen = new Set<string>();
  for (const def of scopes.defs.byId.values()) {
    const simple = def.qualifiedName?.split('.').pop() ?? def.qualifiedName;
    if (simple !== name) continue;
    if (def.type !== 'Function' && def.type !== 'Method' && def.type !== 'Constructor') continue;
    // Skip file-local defs (e.g. C `static` functions) that live in a
    // different file from the caller — they are logically invisible.
    if (isFileLocalDef !== undefined && def.filePath !== callerFilePath && isFileLocalDef(def)) {
      continue;
    }
    // Caller-side visibility filter (e.g., PHP namespace + use-function
    // import gating). When defined, blocks candidates the caller cannot
    // legally reach. Languages without namespace-scoped function resolution
    // leave this undefined → no filtering.
    if (isCallerVisible !== undefined && !isCallerVisible(def)) {
      continue;
    }
    const key = logicalCallableKey(def);
    if (scopeSeen.has(key)) continue;
    scopeSeen.add(key);
    scopeDefs.push(def);
  }
  if (scopeDefs.length === 1) return scopeDefs[0];

  // When multiple scope-index candidates exist, attempt arity narrowing
  // before falling back to the semantic-model lookup. This handles
  // registry-primary languages where the model is not populated for the
  // migrated language's files (call-processor skips them).
  if (scopeDefs.length > 1 && callArity !== undefined) {
    const arityMatch = narrowByArity(scopeDefs, callArity);
    if (arityMatch !== undefined) return arityMatch;
  }

  const defs: SymbolDefinition[] = [];
  const seen = new Set<string>();
  const push = (pool: readonly SymbolDefinition[]): void => {
    for (const def of pool) {
      // Apply the same file-local linkage filter as Phase 1 —
      // cross-file static defs must never leak through the
      // SemanticModel fallback path.
      if (isFileLocalDef !== undefined && def.filePath !== callerFilePath && isFileLocalDef(def)) {
        continue;
      }
      // Same caller-visibility filter applied to the model-side pool.
      if (isCallerVisible !== undefined && !isCallerVisible(def)) {
        continue;
      }
      const key = logicalCallableKey(def);
      if (seen.has(key)) continue;
      seen.add(key);
      defs.push(def);
    }
  };

  push(model.symbols.lookupCallableByName(name));
  push(model.methods.lookupMethodByName(name));

  if (defs.length === 1) return defs[0];

  // When multiple candidates exist and the call site has a known arity,
  // narrow by parameter count.
  if (defs.length > 1 && callArity !== undefined) {
    const arityMatch = narrowByArity(defs, callArity);
    if (arityMatch !== undefined) return arityMatch;
  }

  return undefined;
}

/**
 * Narrow a list of callable candidates by call-site arity.
 * A def is compatible when `requiredParameterCount <= arity <= parameterCount`.
 * Defs with `parameterCount === undefined` (variadic/unknown) are always kept.
 * Returns the single compatible def, or `undefined` when zero or multiple match.
 */
function narrowByArity(
  defs: readonly SymbolDefinition[],
  callArity: number,
): SymbolDefinition | undefined {
  const compatible = defs.filter((d) => {
    const total = d.parameterCount;
    if (total === undefined) return true; // unknown arity — keep
    const required = d.requiredParameterCount ?? total;
    return required <= callArity && callArity <= total;
  });
  return compatible.length === 1 ? compatible[0] : undefined;
}

function logicalCallableKey(def: SymbolDefinition): string {
  return [
    def.filePath,
    def.qualifiedName ?? '',
    def.type,
    def.parameterCount ?? '',
    def.parameterTypes?.join(',') ?? '',
  ].join('\0');
}

/** For a constructor call `new X(...)`, return the X class's explicit
 *  Constructor def (by walking the class scope's ownedDefs) or the
 *  Class def itself when no explicit Constructor exists. Matches
 *  legacy behavior — tests assert targetLabel === 'Class' for implicit
 *  ctors and targetLabel === 'Constructor' for explicit ones. */
function pickConstructorOrClass(
  classDef: SymbolDefinition,
  workspaceIndex: WorkspaceResolutionIndex,
): SymbolDefinition {
  const classScope = workspaceIndex.classScopeByDefId.get(classDef.nodeId);
  if (classScope === undefined) return classDef;
  for (const def of classScope.ownedDefs) {
    if (def.type === 'Constructor') return def;
  }
  return classDef;
}

/** Walk up from the call-site scope to the enclosing class scope,
 *  pick a method member by name with overload narrowing on arity +
 *  argument types. Returns undefined if there's no enclosing class,
 *  no matching method, OR narrowing leaves multiple compatible
 *  candidates — in the multi-candidate case, picking
 *  `candidates[0]` would emit a high-confidence CALLS edge whose
 *  target depends on registration order rather than a defensible
 *  resolution. Mirrors `pickUniqueGlobalCallable`'s uniqueness check
 *  in the same file (Codex PR #1497 review, finding 2).
 *
 *  Exported for unit testing — language-agnostic logic, exercised
 *  via synthetic stubs in `pick-implicit-this-overload.test.ts`. The
 *  production call site is `applyFreeCallFallback` immediately above. */
export function pickImplicitThisOverload(
  site: {
    readonly inScope: ScopeId;
    readonly name: string;
    readonly arity?: number;
    readonly argumentTypes?: readonly string[];
  },
  scopes: ScopeResolutionIndexes,
  workspaceIndex: WorkspaceResolutionIndex,
  model: SemanticModel,
): SymbolDefinition | undefined {
  // Find the enclosing Class scope by walking parents.
  let curId: ScopeId | null = site.inScope;
  let classScopeId: ScopeId | undefined;
  while (curId !== null) {
    const sc = scopes.scopeTree.getScope(curId);
    if (sc === undefined) break;
    if (sc.kind === 'Class') {
      classScopeId = sc.id;
      break;
    }
    curId = sc.parent;
  }
  if (classScopeId === undefined) return undefined;

  // O(1) reverse-lookup via inverse map on WorkspaceResolutionIndex.
  const classDefId = workspaceIndex.classScopeIdToDefId.get(classScopeId);
  if (classDefId === undefined) return undefined;

  const overloads = model.methods.lookupAllByOwner(classDefId, site.name);
  if (overloads.length === 0) return undefined;
  if (overloads.length === 1) return overloads[0];

  // Narrow on arity + argument types. Require a UNIQUE survivor —
  // ambiguous narrowing (multiple compatible candidates with no
  // disambiguating signal) leaves the call unresolved rather than
  // routing to an arbitrary first overload by registration order.
  const candidates = narrowOverloadCandidates(overloads, site.arity, site.argumentTypes);
  if (candidates.length !== 1) return undefined;
  return candidates[0];
}
