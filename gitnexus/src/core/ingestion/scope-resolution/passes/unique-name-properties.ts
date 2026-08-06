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
import { getLanguageFromFilename } from 'gitnexus-shared';

/** Language a definition lives in, for reporting which anchor a reader cannot reach. */
function languageOf(filePath: string): string {
  return getLanguageFromFilename(filePath) ?? 'unknown';
}

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
  /**
   * Read/write sites whose name IS defined in the workspace, but only in
   * ANOTHER language — so per-language inference correctly declined, and the
   * caller got an empty result byte-identical to "this field is unused".
   *
   * Keeping this separate from {@link ambiguous} matters: ambiguity means the
   * analyzer saw several candidates and refused to choose, while this means it
   * saw candidates it was not allowed to consider. The remedies differ — one
   * wants better receiver typing, the other wants an anchor in this language
   * (or a text search) — so collapsing them would tell a reader the wrong thing
   * to do.
   */
  readonly crossLanguageOnly: number;
  /**
   * The distinct names behind {@link crossLanguageOnly}, capped, each with the
   * languages its definitions actually live in. That is the actionable half:
   * "wickRatio is defined only in TypeScript" tells a reader why their
   * JavaScript query came back empty and what to do about it.
   */
  readonly crossLanguageOnlyNames: readonly {
    readonly name: string;
    readonly languages: string[];
  }[];
}

/**
 * Every `Property` node in the graph, grouped by name.
 *
 * WHOLE-GRAPH AND LANGUAGE-AGNOSTIC, so it is built ONCE by the caller and
 * shared across every language pass — the same treatment `sharedNodeLookup` and
 * `sharedFnNodeIndex` already get in `phase.ts`, and for the same reason: a
 * per-language rebuild scans every node in the repo N times, and on a large
 * repo a small language's full copy overlaps the next language's.
 *
 * Deliberately NOT capped here. The cap belongs after the language filter (see
 * {@link candidatesForLanguage}) — a name carried by forty properties across a
 * polyglot monorepo but only two in the language being resolved is answerable,
 * and capping globally would refuse it. One entry per Property node is the same
 * order as the node-lookup map built beside it.
 */
export type PropertyNameIndex = ReadonlyMap<string, readonly PropertyCandidate[]>;

export function buildPropertyNameIndex(graph: KnowledgeGraph): PropertyNameIndex {
  const byName = new Map<string, PropertyCandidate[]>();
  for (const node of graph.iterNodes()) {
    if (node.label !== 'Property') continue;
    const name = node.properties.name;
    if (typeof name !== 'string' || name.length === 0) continue;
    const filePath = node.properties.filePath;
    if (typeof filePath !== 'string') continue;
    const existing = byName.get(name);
    if (existing === undefined) {
      byName.set(name, [{ id: node.id, filePath }]);
      continue;
    }
    if (existing.some((c) => c.id === node.id)) continue;
    existing.push({ id: node.id, filePath });
  }
  return byName;
}

/**
 * The candidates a read in THIS language may consider, or {@link OVERSATURATED}
 * when there are too many to disambiguate.
 *
 * SAME LANGUAGE ONLY. The graph is shared across every language in the repo, and
 * `fieldFallbackOnMethodLookup` only decides whether this pass RUNS for a
 * language — it never restricted which nodes could be TARGETS. So a Java backend
 * declaring `private int loyaltyPoints` was the unique carrier of that name, and
 * a JS frontend writing `cfg.loyaltyPoints` on an untyped parameter got an edge
 * to it: no owner, file, or language evidence, and inference across a language
 * boundary that has no call path at all. The confidence tier does not save it,
 * since `minConfidence` defaults to 0.
 *
 * `parsedFiles` is exactly this language's file set, so matching on it is a
 * precise restriction rather than a heuristic — no node property needed.
 *
 * The cap is applied HERE, to the filtered set, so it means what it says: this
 * many same-named keys IN THE LANGUAGE BEING RESOLVED is a generic name no tier
 * can disambiguate.
 */
function candidatesForLanguage(
  all: readonly PropertyCandidate[],
  ownFilePaths: ReadonlySet<string>,
): readonly PropertyCandidate[] | null | undefined {
  const mine: PropertyCandidate[] = [];
  for (const candidate of all) {
    if (!ownFilePaths.has(candidate.filePath)) continue;
    if (mine.length >= MAX_TRACKED_CANDIDATES) return OVERSATURATED;
    mine.push(candidate);
  }
  // Three outcomes, and they are not interchangeable: `undefined` means no
  // property of this name exists in this language (nothing to say HERE, though
  // see `crossLanguageAnchors` for why the CALLER still needs to know), `null`
  // means too many to choose between (reportable), and a list means proceed to
  // narrowing.
  return mine.length === 0 ? undefined : mine;
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
  /**
   * Whole-graph `Property`-by-name index built ONCE by the caller and shared
   * across every language pass. It is a full node scan and language-agnostic,
   * so rebuilding it per language repeats that scan N times — the pattern
   * `phase.ts` already hoisted out for `sharedNodeLookup`. Built locally when
   * omitted (tests / isolated calls).
   */
  prebuiltPropertyNameIndex?: PropertyNameIndex,
): UniqueNamePropertyStats {
  const byName = prebuiltPropertyNameIndex ?? buildPropertyNameIndex(graph);
  const ownFilePaths = new Set(parsedFiles.map((p) => p.filePath));
  if (byName.size === 0) {
    return {
      emitted: 0,
      ambiguous: 0,
      narrowed: 0,
      ambiguousNames: [],
      crossLanguageOnly: 0,
      crossLanguageOnlyNames: [],
    };
  }
  const directImports =
    finalized === undefined
      ? new Map<string, ReadonlySet<string>>()
      : buildDirectImportMap(parsedFiles, finalized);

  let emitted = 0;
  let ambiguous = 0;
  let narrowed = 0;
  let crossLanguageOnly = 0;
  const ambiguousNames = new Set<string>();
  /** name -> the languages its definitions actually live in. */
  const crossLanguageAnchors = new Map<string, Set<string>>();
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

      const allWithName = byName.get(site.name);
      if (allWithName === undefined) continue;
      const candidates = candidatesForLanguage(allWithName, ownFilePaths);
      if (candidates === undefined) {
        // The name IS defined in this workspace, just not in a language this
        // pass may infer across — so declining is correct, and staying silent
        // about it is not. An empty answer here is byte-identical to "this
        // field is unused", which is the confident-empty failure this whole
        // series exists to remove; the only difference is that the missing
        // fact is now about the ANALYZER's reach rather than the code's.
        crossLanguageOnly++;
        if (!crossLanguageAnchors.has(site.name)) {
          crossLanguageAnchors.set(
            site.name,
            new Set(allWithName.map((c) => languageOf(c.filePath))),
          );
        }
        continue;
      }
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
    crossLanguageOnly,
    crossLanguageOnlyNames: Array.from(crossLanguageAnchors)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, MAX_REPORTED_AMBIGUOUS_NAMES)
      .map(([name, languages]) => ({ name, languages: Array.from(languages).sort() })),
  };
}
