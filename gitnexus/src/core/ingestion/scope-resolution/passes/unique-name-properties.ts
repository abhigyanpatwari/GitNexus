/**
 * Last-resort property resolution by UNIQUE NAME (A1/A5).
 *
 * Idiomatic JS reads configuration off a plain object whose receiver cannot be
 * typed — an options bag passed as a parameter, a destructured handle, an
 * imported literal. The precise passes resolve none of those, so a field read
 * and written across a live code path produced no `ACCESSES` edge at all and
 * "who reads this setting?" answered a confident zero.
 *
 * This pass runs AFTER every precise pass and only sees what they left behind.
 * For each still-unresolved read/write site it asks one question: does exactly
 * ONE `Property` node in the graph carry this name? If so the read almost
 * certainly means it, and an edge is emitted at REDUCED CONFIDENCE with a
 * reason that names the inference. If two or more carry the name, nothing is
 * emitted — a guess between them would be a coin flip, and a wrong edge in the
 * pre-edit safety gate is worse than a missing one.
 *
 * Why uniqueness is the right gate: the names this recovers are the ones worth
 * recovering. Distinctive domain fields (`exitMinAtrMult`, `bookNotionalUsdt`)
 * are unique in a repo and resolve; generic keys (`id`, `name`, `data`) are not
 * and are skipped, which is exactly where name matching would over-connect.
 * That is the `fieldFallbackOnMethodLookup` trade this codebase already accepts
 * for dynamic languages, bounded so it cannot fire on the ambiguous majority.
 *
 * Confidence is 0.5 — the same tier the 3-tier import resolver assigns its
 * global fallback, because this is the same kind of claim: a name matched
 * workspace-wide with no scope evidence behind it.
 *
 * WHY GRAPH NODES, NOT SCOPE DEFS: an object-literal key mints a `Property`
 * NODE (parse query) but no scope-resolution DEF, so `scope.bindings` and
 * `localDefs` are both empty for exactly the population this pass exists to
 * serve. Indexing the graph is therefore not a shortcut — it is the only place
 * these symbols exist. It also means the pass emits straight to the graph
 * rather than through `tryEmitEdge`, whose target side takes a def.
 */

import type { ParsedFile } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { GraphNodeLookup } from '../graph-bridge/node-lookup.js';
import { resolveCallerGraphId } from '../graph-bridge/ids.js';

/**
 * Confidence for a workspace-unique name match. Deliberately the global tier's
 * 0.5 and not the 0.85 default: a consumer filtering on confidence must be able
 * to drop these without dropping scope-resolved edges.
 */
const UNIQUE_NAME_CONFIDENCE = 0.5;

const EDGE_REASON = 'scope-resolution: unique-name property';

/** Sentinel for "more than one node carries this name" — never resolved. */
const AMBIGUOUS = null;

export interface UniqueNamePropertyStats {
  /** Edges emitted from a workspace-unique name match. */
  readonly emitted: number;
  /**
   * Sites skipped because two or more `Property` nodes share the name, so a
   * unique-name match would have been a coin flip. Reported rather than
   * silently dropped: this is the population a receiver-typing improvement
   * would convert into precise edges.
   */
  readonly ambiguous: number;
}

/**
 * Index `Property` nodes by name, collapsing any name with two or more nodes
 * to {@link AMBIGUOUS} immediately. Storing the sentinel instead of a list
 * keeps a repo full of same-named keys (`id`, `type`, `value`) from
 * materializing an array per key.
 */
function indexUniquePropertyNodes(graph: KnowledgeGraph): ReadonlyMap<string, string | null> {
  const byName = new Map<string, string | null>();
  for (const node of graph.iterNodes()) {
    if (node.label !== 'Property') continue;
    const name = node.properties.name;
    if (typeof name !== 'string' || name.length === 0) continue;
    const existing = byName.get(name);
    if (existing === undefined) {
      byName.set(name, node.id);
    } else if (existing !== AMBIGUOUS && existing !== node.id) {
      byName.set(name, AMBIGUOUS);
    }
  }
  return byName;
}

export function emitUniqueNamePropertyAccesses(
  graph: KnowledgeGraph,
  indexes: ScopeResolutionIndexes,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
  /** Sites a precise pass already owns — never second-guessed here. */
  skipSites: ReadonlySet<string>,
): UniqueNamePropertyStats {
  const byName = indexUniquePropertyNodes(graph);
  if (byName.size === 0) return { emitted: 0, ambiguous: 0 };

  let emitted = 0;
  let ambiguous = 0;
  const seen = new Set<string>();

  for (const parsed of parsedFiles) {
    for (const site of parsed.referenceSites) {
      if (site.kind !== 'read' && site.kind !== 'write') continue;
      // A bare identifier is not a property access — without a receiver there
      // is no object whose member this could be, and matching one by name
      // would link a local variable to an unrelated object's key.
      if (site.explicitReceiver === undefined) continue;
      const siteKey = `${parsed.filePath}:${site.atRange.startLine}:${site.atRange.startCol}`;
      if (skipSites.has(siteKey)) continue;

      const targetId = byName.get(site.name);
      if (targetId === undefined) continue;
      if (targetId === AMBIGUOUS) {
        ambiguous++;
        continue;
      }

      const callerGraphId = resolveCallerGraphId(site.inScope, indexes, nodeLookup, site.atRange);
      if (callerGraphId === undefined) continue;
      // A property reading itself is not a fact about anything.
      if (callerGraphId === targetId) continue;

      const dedupKey = `ACCESSES:${callerGraphId}->${targetId}:${site.atRange.startLine}:${site.atRange.startCol}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      // `addRelationship` is first-write-wins, so a precise edge already
      // emitted for this exact id keeps ownership over the inference.
      graph.addRelationship({
        id: `rel:${dedupKey}`,
        sourceId: callerGraphId,
        targetId,
        type: 'ACCESSES',
        confidence: UNIQUE_NAME_CONFIDENCE,
        reason: `${EDGE_REASON}: ${site.kind}`,
        evidence: [],
      });
      emitted++;
    }
  }

  return { emitted, ambiguous };
}
