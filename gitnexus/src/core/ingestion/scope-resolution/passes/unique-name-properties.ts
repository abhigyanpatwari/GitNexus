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
 * ── R2: workspace uniqueness is too blunt on its own ────────────────────────
 *
 * Measured on the repo this pass was written for: `exitMinAtrMult` has 26
 * `Property` definitions — 16 of them in one-off `scripts/`, 7 in the frontend,
 * one in a test, and exactly ONE in the backend that actually reads it. Strict
 * uniqueness declined every backend read because research scripts the backend
 * has no relationship with each carry a same-named key. The gate was not
 * wrong, it was scope-blind: it compared against the whole workspace when the
 * reader can only plausibly mean something it can SEE.
 *
 * So a name with several definitions is now narrowed before being abandoned:
 *   Tier 1 — a definition in the READING FILE itself.
 *   Tier 2 — a definition in a file the reading file DIRECTLY IMPORTS.
 * Exactly one survivor at the first non-empty tier resolves; anything else is
 * still refused. Narrowing uses the finalized import graph, so it is real
 * evidence rather than a path-shape heuristic, and it is language-neutral.
 *
 * A tier that finds SEVERAL candidates stops the walk instead of falling
 * through to the next one. Two same-named keys in the reading file mean the
 * read is genuinely ambiguous where the reader is standing; reaching past them
 * to an imported file would answer a question the local evidence already
 * contradicts.
 *
 * Confidence stays 0.5 for every tier. Narrowing improves which candidate is
 * chosen, not the kind of claim being made — it is still a name match, and the
 * round-1 contract is that a consumer filtering on confidence can drop all
 * name inference without dropping scope-resolved edges. The reason string
 * records which tier fired.
 *
 * WHY GRAPH NODES, NOT SCOPE DEFS: an object-literal key mints a `Property`
 * NODE (parse query) but no scope-resolution DEF, so `scope.bindings` and
 * `localDefs` are both empty for exactly the population this pass exists to
 * serve. Indexing the graph is therefore not a shortcut — it is the only place
 * these symbols exist. It also means the pass emits straight to the graph
 * rather than through `tryEmitEdge`, whose target side takes a def.
 */

import type { ImportEdge, ParsedFile, ScopeId } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { GraphNodeLookup } from '../graph-bridge/node-lookup.js';
import { resolveCallerGraphId } from '../graph-bridge/ids.js';
import { callableFlowSiteKey } from './callable-value-flow.js';

/**
 * Confidence for a workspace-unique name match. Deliberately the global tier's
 * 0.5 and not the 0.85 default: a consumer filtering on confidence must be able
 * to drop these without dropping scope-resolved edges.
 */
const UNIQUE_NAME_CONFIDENCE = 0.5;

const EDGE_REASON = 'scope-resolution: unique-name property';

/**
 * Most candidates any one name will keep for narrowing. A name carried by more
 * definitions than this is a generic key (`id`, `type`, `value`) that no tier
 * is going to disambiguate, so the candidate list is dropped and the name is
 * treated as ambiguous outright. This is what keeps the index from
 * materializing a long array per generic key in a large repo — the concern
 * that made the original implementation store a sentinel instead of a list.
 */
const MAX_TRACKED_CANDIDATES = 32;

/** Sentinel for "too many nodes carry this name to narrow" — never resolved. */
const OVERSATURATED = null;

interface PropertyCandidate {
  readonly id: string;
  readonly filePath: string;
}

/**
 * The only part of the finalized scope model this pass reads. Narrowed to a
 * structural type so the pass does not depend on the full finalize result.
 */
interface FinalizedImportView {
  readonly imports: ReadonlyMap<ScopeId, readonly ImportEdge[]>;
}

/** Most distinct names reported back; enough to act on, bounded for logs. */
const MAX_REPORTED_AMBIGUOUS_NAMES = 25;

export interface UniqueNamePropertyStats {
  /** Edges emitted from a name match at any tier. */
  readonly emitted: number;
  /**
   * Sites skipped because the name could not be narrowed to one definition,
   * so a match would have been a coin flip. Reported rather than silently
   * dropped: this is the population a receiver-typing improvement would
   * convert into precise edges.
   */
  readonly ambiguous: number;
  /**
   * Of {@link emitted}, how many needed scope narrowing — the name carried
   * several definitions and same-file or direct-import evidence picked one.
   * Strict workspace uniqueness would have refused every one of these.
   */
  readonly narrowed: number;
  /**
   * The distinct names behind {@link ambiguous}, capped. A bare count says a
   * gap exists; the names say WHICH fields are unanswerable, which is the
   * difference between a metric and something a reader can act on.
   */
  readonly ambiguousNames: readonly string[];
}

/**
 * Index `Property` nodes by name, keeping each name's candidates up to
 * {@link MAX_TRACKED_CANDIDATES} so a multi-candidate name can still be
 * narrowed by scope. Past the cap the list is dropped for {@link OVERSATURATED}
 * — that many same-named keys is a generic name no tier can disambiguate, and
 * holding the array would cost memory for a question that has no answer.
 */
function indexPropertyNodesByName(
  graph: KnowledgeGraph,
  ownFilePaths: ReadonlySet<string>,
): ReadonlyMap<string, readonly PropertyCandidate[] | null> {
  const byName = new Map<string, PropertyCandidate[] | null>();
  for (const node of graph.iterNodes()) {
    if (node.label !== 'Property') continue;
    const name = node.properties.name;
    if (typeof name !== 'string' || name.length === 0) continue;
    const filePath = node.properties.filePath;
    // SAME LANGUAGE ONLY. The graph is shared across every language in the
    // repo, and `fieldFallbackOnMethodLookup` only decides whether this pass
    // RUNS for a language — it never restricted which nodes could be TARGETS.
    // So a Java backend declaring `private int loyaltyPoints` was the unique
    // carrier of that name, and a JS frontend writing `cfg.loyaltyPoints` on an
    // untyped parameter got an edge to it: no owner, file, or language evidence,
    // and inference across a language boundary that has no call path at all.
    // The confidence tier does not save it, since `minConfidence` defaults to 0.
    //
    // `parsedFiles` is exactly this language's file set, so matching on it is a
    // precise restriction rather than a heuristic — no node property needed.
    if (typeof filePath !== 'string' || !ownFilePaths.has(filePath)) continue;
    const existing = byName.get(name);
    if (existing === OVERSATURATED) continue;
    const candidate: PropertyCandidate = { id: node.id, filePath };
    if (existing === undefined) {
      byName.set(name, [candidate]);
      continue;
    }
    if (existing.some((c) => c.id === candidate.id)) continue;
    if (existing.length >= MAX_TRACKED_CANDIDATES) {
      byName.set(name, OVERSATURATED);
      continue;
    }
    existing.push(candidate);
  }
  return byName;
}

/**
 * Files each file directly imports, from the FINALIZED import graph.
 *
 * Built from `finalized.imports` rather than the raw per-scope edges because
 * only the finalized form has `targetFile` linked — pre-finalize the field is
 * still null for anything the resolver had to look up, which would silently
 * narrow every read to nothing.
 */
function buildDirectImportMap(
  parsedFiles: readonly ParsedFile[],
  finalized: FinalizedImportView,
): ReadonlyMap<string, ReadonlySet<string>> {
  const scopeToFile = new Map<string, string>();
  for (const parsed of parsedFiles) {
    for (const scope of parsed.scopes) {
      scopeToFile.set(scope.id, parsed.filePath);
    }
  }

  const byFile = new Map<string, Set<string>>();
  for (const [scopeId, edges] of finalized.imports) {
    const fromFile = scopeToFile.get(scopeId);
    if (fromFile === undefined) continue;
    for (const edge of edges) {
      if (edge.targetFile === null || edge.targetFile === fromFile) continue;
      let set = byFile.get(fromFile);
      if (set === undefined) {
        set = new Set<string>();
        byFile.set(fromFile, set);
      }
      set.add(edge.targetFile);
    }
  }
  return byFile;
}

/**
 * Pick the single candidate a read in `readingFile` can plausibly mean.
 *
 * Tiers are tried in order and the FIRST non-empty one decides — including
 * deciding to refuse. A tier holding several candidates returns null rather
 * than falling through, because local evidence that is itself ambiguous is
 * still evidence: reaching past two same-named keys in the reading file to an
 * imported third would answer a question the reader's own file contradicts.
 */
function narrowToSingleCandidate(
  candidates: readonly PropertyCandidate[],
  readingFile: string,
  importedFiles: ReadonlySet<string> | undefined,
): { readonly id: string; readonly tier: string } | null {
  if (candidates.length === 1) {
    return { id: candidates[0]!.id, tier: 'workspace-unique' };
  }

  const sameFile = candidates.filter((c) => c.filePath === readingFile);
  if (sameFile.length > 0) {
    return sameFile.length === 1 ? { id: sameFile[0]!.id, tier: 'same-file' } : null;
  }

  if (importedFiles === undefined) return null;
  const imported = candidates.filter((c) => importedFiles.has(c.filePath));
  if (imported.length > 0) {
    return imported.length === 1 ? { id: imported[0]!.id, tier: 'imported-file' } : null;
  }

  return null;
}

export function emitUniqueNamePropertyAccesses(
  graph: KnowledgeGraph,
  indexes: ScopeResolutionIndexes,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
  /** Sites a precise pass already owns — never second-guessed here. */
  skipSites: ReadonlySet<string>,
  /** Finalized import graph; narrows a name carried by several definitions. */
  finalized?: FinalizedImportView,
): UniqueNamePropertyStats {
  const byName = indexPropertyNodesByName(graph, new Set(parsedFiles.map((p) => p.filePath)));
  if (byName.size === 0) {
    return { emitted: 0, ambiguous: 0, narrowed: 0, ambiguousNames: [] };
  }
  const directImports =
    finalized === undefined
      ? new Map<string, ReadonlySet<string>>()
      : buildDirectImportMap(parsedFiles, finalized);

  let emitted = 0;
  let ambiguous = 0;
  let narrowed = 0;
  const ambiguousNames = new Set<string>();
  const seen = new Set<string>();

  for (const parsed of parsedFiles) {
    for (const site of parsed.referenceSites) {
      if (site.kind !== 'read' && site.kind !== 'write') continue;
      // A bare identifier is not a property access — without a receiver there
      // is no object whose member this could be, and matching one by name
      // would link a local variable to an unrelated object's key.
      if (site.explicitReceiver === undefined) continue;
      const siteKey = callableFlowSiteKey(parsed.filePath, site.atRange);
      if (skipSites.has(siteKey)) continue;

      const candidates = byName.get(site.name);
      if (candidates === undefined) continue;
      if (candidates === OVERSATURATED) {
        ambiguous++;
        ambiguousNames.add(site.name);
        continue;
      }

      const choice = narrowToSingleCandidate(
        candidates,
        parsed.filePath,
        directImports.get(parsed.filePath),
      );
      if (choice === null) {
        ambiguous++;
        ambiguousNames.add(site.name);
        continue;
      }
      const targetId = choice.id;
      if (choice.tier !== 'workspace-unique') narrowed++;

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
        reason: `${EDGE_REASON} (${choice.tier}): ${site.kind}`,
        evidence: [],
      });
      emitted++;
    }
  }

  return {
    emitted,
    ambiguous,
    narrowed,
    ambiguousNames: Array.from(ambiguousNames).sort().slice(0, MAX_REPORTED_AMBIGUOUS_NAMES),
  };
}
