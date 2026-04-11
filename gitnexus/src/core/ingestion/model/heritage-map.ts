/**
 * Heritage Map
 *
 * Unified inheritance data structure built from accumulated
 * {@link ExtractedHeritage} records **after all chunks complete** (between
 * chunk processing and call resolution). Consumes `ExtractedHeritage[]` and
 * resolves type names to nodeIds via `lookupClassByName`, NOT graph-edge
 * queries.
 *
 * Combines two concerns:
 * 1. **Parent/ancestor lookup** (MRO-aware method resolution)
 * 2. **Implementor lookup** (interface dispatch — which files contain
 *    classes implementing a given interface)
 */

import type { ResolutionContext } from './resolution-context.js';
import { getLanguageFromFilename, type SupportedLanguages } from 'gitnexus-shared';

// ---------------------------------------------------------------------------
// ExtractedHeritage — the shape produced by the parse worker / heritage
// extractor. Defined here so `model/` has no upward imports; consumers
// import this type from the model module.
// ---------------------------------------------------------------------------

export interface ExtractedHeritage {
  filePath: string;
  className: string;
  parentName: string;
  /** 'extends' | 'implements' | 'trait-impl' | 'include' | 'extend' | 'prepend' */
  kind: string;
}

// ---------------------------------------------------------------------------
// Heritage resolution strategy (the per-language knobs that drive
// `resolveExtendsType` below). Pulled out as an explicit strategy object so
// the model layer depends on a plain data shape rather than on the language
// provider registry.
// ---------------------------------------------------------------------------

export interface HeritageResolutionStrategy {
  /** If set and the parent name matches, force IMPLEMENTS even when the
   *  symbol is unresolved (e.g. `/^I[A-Z]/` for C# / Java). */
  readonly interfaceNamePattern?: RegExp;
  /** Fallback edge for unresolved parents when the name pattern doesn't
   *  match (Swift uses 'IMPLEMENTS' for protocol conformance). */
  readonly defaultEdge: 'EXTENDS' | 'IMPLEMENTS';
}

/** Callback used by `buildHeritageMap` to look up the resolution strategy
 *  for a given language. Injected by callers so the model module doesn't
 *  depend on `../languages/index.js`. */
export type HeritageStrategyLookup = (lang: SupportedLanguages) => HeritageResolutionStrategy;

/**
 * Determine whether a heritage.extends capture is actually an IMPLEMENTS
 * relationship. Consults the symbol table first (authoritative — Tier 1 /
 * Tier 2 resolution); falls back to the injected {@link HeritageResolutionStrategy}
 * heuristics for external symbols not present in the graph.
 */
export const resolveExtendsType = (
  parentName: string,
  currentFilePath: string,
  ctx: ResolutionContext,
  strategy: HeritageResolutionStrategy,
): { type: 'EXTENDS' | 'IMPLEMENTS'; idPrefix: string } => {
  const resolved = ctx.resolve(parentName, currentFilePath);
  if (resolved && resolved.candidates.length > 0) {
    const isInterface = resolved.candidates[0].type === 'Interface';
    return isInterface
      ? { type: 'IMPLEMENTS', idPrefix: 'Interface' }
      : { type: 'EXTENDS', idPrefix: 'Class' };
  }
  // Unresolved symbol — fall back to strategy heuristics.
  if (strategy.interfaceNamePattern?.test(parentName)) {
    return { type: 'IMPLEMENTS', idPrefix: 'Interface' };
  }
  if (strategy.defaultEdge === 'IMPLEMENTS') {
    return { type: 'IMPLEMENTS', idPrefix: 'Interface' };
  }
  return { type: 'EXTENDS', idPrefix: 'Class' };
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Maximum ancestor chain depth to prevent runaway traversal. */
const MAX_ANCESTOR_DEPTH = 32;

export interface HeritageMap {
  /** Direct parents of `childNodeId` (extends + implements + trait-impl). */
  getParents(childNodeId: string): string[];
  /** Full ancestor chain (BFS, bounded depth, cycle-safe). */
  getAncestors(childNodeId: string): string[];
  /**
   * File paths of classes that directly implement or extend-as-interface the
   * given interface/abstract-class **name**. Replaces the standalone
   * `ImplementorMap` — used by interface-dispatch in call resolution.
   */
  getImplementorFiles(interfaceName: string): ReadonlySet<string>;
}

/** Shared empty set returned when no implementors are found. */
const EMPTY_SET: ReadonlySet<string> = new Set();

/** Default strategy used when `buildHeritageMap` is called without an
 *  explicit `getHeritageStrategy` callback — the fallback for a language
 *  whose provider sets no interface-name pattern and no non-default
 *  `heritageDefaultEdge`. */
const DEFAULT_HERITAGE_STRATEGY: HeritageResolutionStrategy = { defaultEdge: 'EXTENDS' };

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build a HeritageMap from accumulated ExtractedHeritage records.
 *
 * Resolves class/interface/struct/trait names to nodeIds via
 * `ctx.model.types.lookupClassByName`. When a name resolves to multiple
 * candidates, all are recorded (partial-class / cross-file scenario).
 * Unresolvable names are silently skipped — a missing parent is better
 * than a wrong edge.
 *
 * Also builds the implementor index (interface name → implementing file
 * paths) used by interface-dispatch in call resolution.
 */
export const buildHeritageMap = (
  heritage: readonly ExtractedHeritage[],
  ctx: ResolutionContext,
  getHeritageStrategy?: HeritageStrategyLookup,
): HeritageMap => {
  // childNodeId → Set<parentNodeId>  (Set to deduplicate cross-chunk duplicates)
  const directParents = new Map<string, Set<string>>();

  // interfaceName → Set<filePath>  (implementor lookup for interface dispatch)
  const implementorFiles = new Map<string, Set<string>>();

  for (const h of heritage) {
    // ── Parent lookup (nodeId-based) ────────────────────────────────
    const childDefs = ctx.model.types.lookupClassByName(h.className);
    const parentDefs = ctx.model.types.lookupClassByName(h.parentName);

    if (childDefs.length > 0 && parentDefs.length > 0) {
      for (const child of childDefs) {
        for (const parent of parentDefs) {
          // Skip self-references
          if (child.nodeId === parent.nodeId) continue;

          let parents = directParents.get(child.nodeId);
          if (!parents) {
            parents = new Set();
            directParents.set(child.nodeId, parents);
          }
          parents.add(parent.nodeId);
        }
      }
    }

    // ── Implementor index (name-based) ──────────────────────────────
    //
    // Known limitation: Rust `kind: 'trait-impl'` entries are intentionally NOT
    // added to the implementor index. Interface dispatch resolution currently
    // does not traverse Rust trait objects, so recording them here would
    // inflate the index without a consumer. Revisit if/when trait-object
    // dispatch is added.
    //
    // Known limitation: `getImplementorFiles` is keyed by interface **name**
    // (string), so two interfaces with the same unqualified name in different
    // packages (e.g. `pkgA.IRepository` vs `pkgB.IRepository`) collide.
    let isImpl = false;
    if (h.kind === 'implements') {
      isImpl = true;
    } else if (h.kind === 'extends') {
      const lang = getLanguageFromFilename(h.filePath);
      if (lang) {
        const strategy = getHeritageStrategy?.(lang) ?? DEFAULT_HERITAGE_STRATEGY;
        const { type } = resolveExtendsType(h.parentName, h.filePath, ctx, strategy);
        isImpl = type === 'IMPLEMENTS';
      }
    }
    if (isImpl) {
      let files = implementorFiles.get(h.parentName);
      if (!files) {
        files = new Set();
        implementorFiles.set(h.parentName, files);
      }
      files.add(h.filePath);
    }
  }

  // --- Public API ---------------------------------------------------

  const getParents = (childNodeId: string): string[] => {
    const parents = directParents.get(childNodeId);
    return parents ? [...parents] : [];
  };

  const getAncestors = (childNodeId: string): string[] => {
    const result: string[] = [];
    const visited = new Set<string>();
    visited.add(childNodeId); // prevent cycles through the start node

    // BFS with bounded depth
    let frontier = getParents(childNodeId);
    let depth = 0;

    while (frontier.length > 0 && depth < MAX_ANCESTOR_DEPTH) {
      const nextFrontier: string[] = [];
      for (const parentId of frontier) {
        if (visited.has(parentId)) continue;
        visited.add(parentId);
        result.push(parentId);
        // Expand parent's own parents for next level
        const grandparents = directParents.get(parentId);
        if (grandparents) {
          for (const gp of grandparents) {
            if (!visited.has(gp)) nextFrontier.push(gp);
          }
        }
      }
      frontier = nextFrontier;
      depth++;
    }

    return result;
  };

  const getImplementorFiles = (interfaceName: string): ReadonlySet<string> => {
    return implementorFiles.get(interfaceName) ?? EMPTY_SET;
  };

  return { getParents, getAncestors, getImplementorFiles };
};
