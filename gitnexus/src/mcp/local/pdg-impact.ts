/**
 * PDG-backed impact helpers.
 *
 * Extracted from `local-backend.ts` so LocalBackend owns dispatch/repo lifecycle
 * while this module owns the PDG layer probe, statement traversal, block
 * projection, and result assembly contract.
 */

import path from 'path';
import type { executeParameterized } from '../../core/lbug/pool-adapter.js';
import { loadMeta } from '../../storage/repo-manager.js';
import { IMPACT_MAX_DEPTH, PDG_QUERY_DEFAULT_LIMIT, PDG_QUERY_MAX_LIMIT } from '../tools.js';

/**
 * Parse the `<fnLine>` segment out of a `BasicBlock` id (1-based function start
 * line). The id template is
 *   `BasicBlock:<filePath>:<fnLine>:<fnCol>:<blockIdx>`
 * and `<filePath>` may itself contain `':'` (a Windows drive letter), so the
 * segments are taken from the RIGHT: `<blockIdx>` is last, `<fnCol>` second-last,
 * `<fnLine>` third-last. Extracted from the `_pdgQueryImpl` closure (#2086) into
 * a shared module-scope helper so the PDG impact traversal (U3/U4) reuses the
 * exact same parse — the `pdg_query` read path is byte-identical to before.
 */
export function fnLineOf(id: string): number {
  const parts = id.split(':');
  return Number(parts[parts.length - 3]);
}

/**
 * Parse the `<filePath>` segment out of a `BasicBlock` id, the COUNTERPART to
 * `fnLineOf`. The id template is `BasicBlock:<filePath>:<fnLine>:<fnCol>:<blockIdx>`,
 * so the file path is everything BETWEEN the `BasicBlock:` prefix and the last
 * THREE colon-segments (`<fnLine>:<fnCol>:<blockIdx>`). `<filePath>` may itself
 * contain `':'` (a Windows drive letter), so we strip from both ends rather than
 * split-and-pick. Returns `''` for an unparseable id (treated as unresolved).
 */
function fnFileOf(id: string): string {
  const parts = id.split(':');
  // Need: `BasicBlock` + filePath(≥1) + fnLine + fnCol + blockIdx ⇒ ≥5 segments.
  if (parts.length < 5 || parts[0] !== 'BasicBlock') return '';
  // Drop the leading `BasicBlock` token and the trailing fnLine/fnCol/blockIdx,
  // rejoin the middle on ':' to restore a path that itself contained colons.
  return parts.slice(1, parts.length - 3).join(':');
}

/** A reachable dependence block resolved to its source statement. */
export interface PdgStatement {
  /** 1-based source line where the statement's block starts. */
  line: number;
  /** Repo-relative file path (parsed from the block id). */
  filePath: string;
  /** The statement's source text (BasicBlock.text), trimmed. */
  text: string;
}

/**
 * Resolve a set of reachable BasicBlock ids to their source statements
 * (line + text), deduped by BasicBlock id and sorted by line. This is the
 * useful output of a statement-anchored PDG slice — the dependent statements the
 * change reaches. A query error propagates (no `.catch` swallow) so a DB failure
 * is never silently reported as "no affected statements".
 */
async function pdgStatementsForBlocks(
  lbugPath: string,
  blockIds: string[],
  exec: typeof executeParameterized,
): Promise<PdgStatement[]> {
  if (blockIds.length === 0) return [];
  const rows = await exec(
    lbugPath,
    `MATCH (b:BasicBlock) WHERE b.id IN $ids
     RETURN b.id AS id, b.startLine AS line, b.text AS text`,
    { ids: blockIds },
  );
  const byKey = new Map<string, PdgStatement>();
  for (const r of rows as any[]) {
    const id = String(r.id ?? r[0] ?? '');
    const line = Number(r.line ?? r[1] ?? 0);
    if (!id || !Number.isFinite(line) || line <= 0) continue;
    const filePath = fnFileOf(id);
    const text = String(r.text ?? r[2] ?? '').trim();
    const key = `${filePath}:${line}:${id}`;
    if (!byKey.has(key)) byKey.set(key, { line, filePath, text });
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
  });
}

// ── Block → owning-symbol projection types (U4) ──────────────────────────────

/**
 * One owning-symbol candidate for a reachable BasicBlock, OR an explicit
 * `unresolved` marker for a block that maps to no `Function`/`Method`/`Constructor` symbol
 * (top-level/free-statement block, or a nested lambda whose start line ≠ any
 * symbol `startLine`). A null `id` is the shadow-path marker — the block is
 * surfaced under its file, never silently dropped (R9: a silent drop is a hidden
 * recall loss).
 */
interface OwningSymbol {
  /** Symbol UID, or `null` for the `unresolved` shadow-path entry. */
  id: string | null;
  name: string;
  /** `'Function' | 'Method' | …`, or `'unresolved'` for the shadow path. */
  type: string;
  filePath: string;
  /** Symbol `startLine` (0-based), present only for a resolved symbol. */
  startLine?: number;
  /**
   * True when this block's `(filePath, startLine)` query matched >1 symbol —
   * same-line, different-name functions that the schema cannot disambiguate
   * (no `startColumn` column; Feasibility Finding 1). ALL colliding symbols are
   * reported (never a silent pick), each carrying this flag.
   */
  ambiguous?: boolean;
}

/**
 * Net-new block → owning-symbol resolver (U4) — the REVERSE of
 * `resolveBlockAnchor` (which goes symbol→blocks). No precedent exists:
 * `_pdgQueryImpl` only ever extracts a raw `functionLine`, never an owning
 * symbol. Lives in the extracted PDG impact engine and takes injected deps so
 * LocalBackend keeps repo lifecycle/dispatch while this module owns projection.
 *
 * For each reachable block id `BasicBlock:<filePath>:<fnLine>:<fnCol>:<blockIdx>`:
 *  - `fnLineOf` → 1-based function start line; `fnFileOf` → file path.
 *  - Query `Function`/`Method`/`Constructor` `WHERE filePath = $f AND startLine = (fnLine-1)`
 *    — block `fnLine` is 1-based, symbol `startLine` is 0-based, so subtract one
 *    (the `[symStart+1]` convention from `resolveBlockAnchor`, applied in
 *    reverse; NOT re-derived).
 *
 * Two non-happy paths, BOTH surfaced (never silent):
 *  - **>1 match** (same-line different-name functions): `fnCol` rides the block
 *    id but the schema has NO `startColumn` column and the symbol id encodes only
 *    the name, so a `(filePath, startLine)` join cannot disambiguate. Report ALL
 *    colliding symbols, each `ambiguous: true` (R4 / Feasibility Finding 1).
 *  - **0 matches** (top-level/free-statement block, or a lambda whose start line
 *    ≠ a symbol `startLine`): one `unresolved` entry (`id: null`) under the
 *    block's file (R9 shadow path).
 *
 * Distinct `(filePath, fnLine)` pairs are queried once each (a block and its
 * siblings in the same function share a pair), so the cost is O(distinct
 * functions), not O(blocks).
 */
async function projectBlocksToSymbols(deps: {
  lbugPath: string;
  blockIds: string[];
  executeParameterized: typeof executeParameterized;
}): Promise<{ symbols: OwningSymbol[]; unresolvedCount: number; ambiguousCount: number }> {
  const { lbugPath, blockIds, executeParameterized: exec } = deps;

  // Group blocks by their (filePath, fnLine) owning-function key so each owning
  // function is resolved with a single query regardless of block count.
  const byFnKey = new Map<string, { filePath: string; symStart: number }>();
  for (const id of blockIds) {
    const filePath = fnFileOf(id);
    const fnLine = fnLineOf(id); // 1-based
    if (!filePath || !Number.isFinite(fnLine)) {
      // Unparseable block id — record an unresolved key so it is reported, never
      // dropped. Use the raw id as the key so duplicates collapse.
      byFnKey.set(`#bad#${id}`, { filePath: filePath || id, symStart: NaN });
      continue;
    }
    const symStart = fnLine - 1; // 0-based symbol startLine (reverse [symStart+1])
    byFnKey.set(`${filePath}#${symStart}`, { filePath, symStart });
  }

  const resolved: OwningSymbol[] = [];
  let unresolvedCount = 0;
  let ambiguousCount = 0;

  await Promise.all(
    Array.from(byFnKey.values()).map(async ({ filePath, symStart }) => {
      if (!Number.isFinite(symStart)) {
        // Unparseable id — shadow-path unresolved under (best-effort) file.
        resolved.push({ id: null, name: '(unresolved)', type: 'unresolved', filePath });
        unresolvedCount += 1;
        return;
      }
      // `Function`/`Method`/`Constructor` carry name+filePath+startLine; the schema has NO
      // `startColumn`, so the join is on (filePath, startLine) only. `filePath`
      // and `symStart` are BOUND as params (KTD11 — never interpolated). A
      // UNION ALL across explicit labels is used rather than a
      // `(s:Function OR s:Method OR s:Constructor)` disjunction (unsupported in the LadybugDB
      // Cypher subset — the established cross-label pattern, see
      // `enrichCandidateLabels`).
      // FIX 6: do NOT swallow a query failure as `[]`. A DB error (lock /
      // corruption / missing path) must NOT masquerade as a genuine no-owning-
      // symbol result — that would silently inflate `unresolvedCount` and hide
      // the failure. Letting it reject propagates through `Promise.all` →
      // `projectBlocksToSymbols` → `_runImpactPDG` → `_impactImpl` up to the
      // `impact()` structured-error catch, where it surfaces as a real error
      // with a recovery suggestion (rather than a clean-looking partial radius).
      const rows = await exec(
        lbugPath,
        `MATCH (s:\`Function\`)
           WHERE s.filePath = $filePath AND s.startLine = $symStart
           RETURN s.id AS id, s.name AS name, 'Function' AS label, s.startLine AS startLine
         UNION ALL
         MATCH (s:\`Method\`)
           WHERE s.filePath = $filePath AND s.startLine = $symStart
           RETURN s.id AS id, s.name AS name, 'Method' AS label, s.startLine AS startLine
         UNION ALL
         MATCH (s:\`Constructor\`)
           WHERE s.filePath = $filePath AND s.startLine = $symStart
           RETURN s.id AS id, s.name AS name, 'Constructor' AS label, s.startLine AS startLine`,
        { filePath, symStart },
      );

      if (rows.length === 0) {
        // No owning symbol — top-level/free-statement block or a lambda whose
        // start line ≠ a symbol startLine. Shadow path: report under its file.
        resolved.push({
          id: null,
          name: '(unresolved)',
          type: 'unresolved',
          filePath,
          startLine: symStart,
        });
        unresolvedCount += 1;
        return;
      }

      // >1 ⇒ ambiguous-projection (same-line, different-name functions). Report
      // ALL colliding symbols, NEVER silently pick one (R4 / Feasibility 1).
      const isAmbiguous = rows.length > 1;
      for (const r of rows) {
        resolved.push({
          id: String((r as any).id ?? (r as any)[0] ?? ''),
          name: String((r as any).name ?? (r as any)[1] ?? ''),
          type: String((r as any).label ?? (r as any)[2] ?? 'Function'),
          filePath,
          startLine: Number((r as any).startLine ?? (r as any)[3] ?? symStart),
          ...(isAmbiguous ? { ambiguous: true as const } : {}),
        });
      }
      if (isAmbiguous) ambiguousCount += 1;
    }),
  );

  // Deterministic order: by filePath, then startLine, then id (unresolved last
  // within a file). Order-independence matters for the parity/fingerprint
  // contract (KTD8 standing interchangeability) and for stable consumer output.
  resolved.sort((a, b) => {
    if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
    const al = a.startLine ?? Number.MAX_SAFE_INTEGER;
    const bl = b.startLine ?? Number.MAX_SAFE_INTEGER;
    if (al !== bl) return al - bl;
    const ai = a.id ?? '￿';
    const bi = b.id ?? '￿';
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });

  return { symbols: resolved, unresolvedCount, ambiguousCount };
}

/**
 * The KTD8 parity fields a PDG impact result carries even when it short-circuits
 * to an empty radius (degraded layer / no PDG body / no dependence reachability).
 *
 * A programmatic consumer iterating `byDepth`, reading `byDepthCounts[1]`, or
 * coalescing `affected_processes`/`affected_modules` must find a well-formed
 * (empty) shape on EVERY early return, not `undefined` (which would render as
 * "isolated"/"no data" instead of "inconclusive"). The CLI branches on
 * `pdgLayer` first so it is safe regardless, but the JSON contract must be
 * uniform across all three early returns — this single source guarantees that.
 */
function emptyPdgParityFields(): {
  byDepth: Record<number, unknown[]>;
  byDepthCounts: Record<number, number>;
  summary: { direct: number; processes_affected: number; modules_affected: number };
  affected_processes: unknown[];
  affected_modules: unknown[];
} {
  return {
    byDepth: {},
    byDepthCounts: { 1: 0 },
    summary: { direct: 0, processes_affected: 0, modules_affected: 0 },
    affected_processes: [],
    affected_modules: [],
  };
}

export interface PdgImpactTarget {
  name: string;
  id?: string;
  type?: string;
  filePath?: string;
}

export interface PdgImpactParityFields {
  byDepth: Record<number, unknown[]>;
  byDepthCounts: Record<number, number>;
  summary: { direct: number; processes_affected: number; modules_affected: number };
  affected_processes: unknown[];
  affected_modules: unknown[];
}

export type PdgImpactEvidence =
  | 'local-dependence'
  | 'owner-projection'
  | 'callgraph-bridge'
  | 'unproven-bridge'
  | 'degraded';

export interface PdgImpactEvidenceSummary {
  statements?: PdgImpactEvidence;
  localSymbols?: PdgImpactEvidence;
  interprocedural?: PdgImpactEvidence;
  localSymbolCount?: number;
  unresolvedBlockCount?: number;
  ambiguousProjectionCount?: number;
  interproceduralEvidenceCounts?: Partial<Record<PdgImpactEvidence, number>>;
}

export interface PdgInterproceduralImpact {
  engine: 'symbol-graph';
  evidence: Extract<PdgImpactEvidence, 'callgraph-bridge' | 'unproven-bridge'>;
  impactedCount: number;
  byDepthCounts: Record<number, number>;
  byDepth: Record<number, unknown[]>;
  evidenceCounts?: Partial<Record<PdgImpactEvidence, number>>;
  /**
   * Statement-precise (proven) subset of `byDepth` — additive. Tighter than
   * `byDepth` for a line-seeded downstream slice (drops `unproven-bridge`
   * symbols not invoked from the dependence slice), equal to it otherwise.
   * `statementPrecision` = |proven| / |reach| (null when there is no reach).
   */
  statementPreciseByDepth?: Record<number, unknown[]>;
  statementPreciseByDepthCounts?: Record<number, number>;
  statementPreciseImpactedCount?: number;
  statementPrecision?: number | null;
  partial: boolean;
}

export interface PdgImpactBaseResult extends PdgImpactParityFields {
  mode: 'pdg';
  target: PdgImpactTarget;
  direction: 'upstream' | 'downstream';
  impactedCount: number;
  risk: 'UNKNOWN';
  note?: string;
  partial?: boolean;
  interproceduralByDepth?: Record<number, unknown[]>;
  interproceduralByDepthCounts?: Record<number, number>;
  interproceduralEpistemic?: string;
  interproceduralBoundaries?: unknown[];
  interproceduralError?: string;
  // Statement-precise (proven) inter-procedural reach, surfaced at the top level
  // alongside interproceduralByDepth (also nested under pdgInterprocedural).
  statementPreciseByDepth?: Record<number, unknown[]>;
  statementPreciseByDepthCounts?: Record<number, number>;
  statementPreciseImpactedCount?: number;
  statementPrecision?: number | null;
  pdgInterprocedural?: PdgInterproceduralImpact;
  pdgEvidence?: PdgImpactEvidenceSummary;
}

export interface PdgImpactSuccessResult extends PdgImpactBaseResult {
  target: Required<PdgImpactTarget>;
  epistemic: 'pdg-intra-procedural';
  reachableBlocks: string[];
  /** The criterion's own seed blocks (changed statement / whole-symbol body). */
  seedBlocks: string[];
  blockCount: number;
  affectedStatements: PdgStatement[];
  affectedStatementCount: number;
  depthReached: number;
  unresolvedBlockCount: number;
  ambiguousProjectionCount: number;
  criterionLine?: number;
  truncated?: boolean;
  truncatedBy?: 'depth' | 'limit';
  truncatedByReasons?: readonly ('depth' | 'limit')[];
}

export interface PdgImpactEmptyResult extends PdgImpactBaseResult {
  target: Required<PdgImpactTarget>;
  epistemic: 'no-pdg-body' | 'pdg-no-block-at-line' | 'pdg-intra-procedural';
  reachableBlocks: string[];
  /** The criterion's own seed blocks (changed statement / whole-symbol body). */
  seedBlocks: string[];
  blockCount: number;
  affectedStatements: PdgStatement[];
  affectedStatementCount: number;
  depthReached: number;
  unresolvedBlockCount: number;
  ambiguousProjectionCount: number;
  criterionLine?: number;
  truncated?: boolean;
  truncatedBy?: 'depth' | 'limit';
  truncatedByReasons?: readonly ('depth' | 'limit')[];
}

export type PdgDegradedLayerState = Exclude<PdgLayerStatus['state'], 'ready'>;
export type PdgDegradedLayerStatus = PdgLayerStatus & { state: PdgDegradedLayerState };

export interface PdgImpactDegradedResult extends PdgImpactBaseResult {
  pdgLayer: PdgDegradedLayerState;
  missingSubLayer?: PdgSubLayer;
  probeError?: string;
  recoverySuggestion?: string;
}

export interface PdgImpactErrorResult {
  mode?: 'pdg';
  error: string;
  target: PdgImpactTarget;
  direction: 'upstream' | 'downstream';
  impactedCount: 0;
  risk: 'UNKNOWN';
  suggestion?: string;
  recoverySuggestion?: string;
}

export type PdgImpactResult =
  | PdgImpactSuccessResult
  | PdgImpactEmptyResult
  | PdgImpactDegradedResult
  | PdgImpactErrorResult;

export function makePdgImpactErrorResult(input: {
  error: string;
  target: PdgImpactTarget;
  direction: 'upstream' | 'downstream';
  mode?: 'pdg';
  suggestion?: string;
  recoverySuggestion?: string;
}): PdgImpactErrorResult {
  return {
    ...(input.mode ? { mode: input.mode } : {}),
    error: input.error,
    target: input.target,
    direction: input.direction,
    impactedCount: 0,
    risk: 'UNKNOWN',
    ...(input.suggestion ? { suggestion: input.suggestion } : {}),
    ...(input.recoverySuggestion ? { recoverySuggestion: input.recoverySuggestion } : {}),
  };
}

export function isPdgDegradedLayerStatus(layer: PdgLayerStatus): layer is PdgDegradedLayerStatus {
  return layer.state !== 'ready';
}

export function makePdgLayerDegradedResult(input: {
  mode: 'pdg';
  target: PdgImpactTarget;
  direction: 'upstream' | 'downstream';
  layer: PdgDegradedLayerStatus;
}): PdgImpactDegradedResult {
  return {
    mode: input.mode,
    pdgLayer: input.layer.state,
    ...(input.layer.missingSubLayer ? { missingSubLayer: input.layer.missingSubLayer } : {}),
    ...(input.layer.probeError ? { probeError: input.layer.probeError } : {}),
    ...(input.layer.recoverySuggestion
      ? { recoverySuggestion: input.layer.recoverySuggestion }
      : {}),
    note: input.layer.note,
    target: input.target,
    direction: input.direction,
    impactedCount: 0,
    risk: 'UNKNOWN',
    ...emptyPdgParityFields(),
  };
}

/**
 * Assemble the consumer-safe PDG impact result (U4 / KTD8 parity matrix).
 *
 * Takes the U3 traversal output (reachable block set + truncation signalling)
 * plus the U4 block→symbol projection, and shapes a result STRUCTURALLY
 * substitutable for the call-graph `_runImpactBFS` result so every consumer
 * (CLI `formatImpactResult`, group `collectImpactSymbolUids`/`mergeRisk`,
 * `impactByUid`) renders it without misrendering. This is a STANDING
 * interchangeability contract, not a one-time check.
 *
 * Field-by-field vs the call-graph result (KTD8):
 *  - `target.id/name/type/filePath` — identical shape (`collectImpactSymbolUids`
 *    keys on `target.id`/`target.filePath`).
 *  - `byDepth` — same `{ [depth]: item[] }` map shape, but COLLAPSED to a single
 *    bucket (`1`): intra-procedural dependence has no meaningful inter-symbol hop
 *    count (block-hops are NOT call-hops). Items carry `{ id, name, type,
 *    filePath, … }` exactly like the call-graph items so `collectImpactSymbolUids`
 *    collects their UIDs. `unresolved` shadow-path entries keep `id: null` (they
 *    are surfaced, never dropped — but collect as no UID).
 *  - `byDepthCounts` — `{ 1: <symbolCount> }`, same shape.
 *  - `affected_processes` / `affected_modules` — empty `[]` (no
 *    STEP_IN_PROCESS/module edges originate from BasicBlocks; consumers coalesce
 *    `[]` safely).
 *  - `epistemic` — a PDG-specific marker (`'pdg-intra-procedural'`), NOT the
 *    callgraph DI/dynamic-dispatch `'lower-bound'` copy. `note` carries the
 *    PDG framing so the CLI prints PDG text, not callgraph boundary text.
 *  - `risk` — the existing `'UNKNOWN'` sentinel (NOT a new label). `mergeRisk`
 *    already coalesces `'UNKNOWN'` correctly (never a confident `LOW`).
 *  - `impactedCount` — count of DISTINCT owning SYMBOLS (resolved UIDs), the
 *    meaningful unit for the impact question ("which symbols are affected").
 *    `blockCount` is retained separately as the raw reachable-block count.
 */
function assemblePdgImpactResult(input: {
  target: { id: string; name: string; type: string; filePath: string };
  direction: 'upstream' | 'downstream';
  reachableBlocks: string[];
  /**
   * The criterion's own seed blocks (the changed statement / whole-symbol body).
   * Surfaced so the dispatcher can prove inter-procedural callees invoked
   * directly on the changed line, which are NOT in `reachableBlocks` (the
   * seed-minus-reachable convention — seeds are the target, not dependents).
   */
  seedBlocks: string[];
  /** Reachable blocks resolved to source statements (the useful slice output). */
  affectedStatements?: PdgStatement[];
  /** The 1-based source line the slice was seeded on (statement mode only). */
  criterionLine?: number;
  projection: { symbols: OwningSymbol[]; unresolvedCount: number; ambiguousCount: number };
  depthReached: number;
  truncated: boolean;
  truncatedBy?: 'depth' | 'limit';
  truncatedByReasons?: readonly ('depth' | 'limit')[];
}): PdgImpactSuccessResult {
  const { target, direction, reachableBlocks, projection } = input;
  const { symbols, unresolvedCount, ambiguousCount } = projection;
  const affectedStatements = input.affectedStatements ?? [];
  const statementMode = typeof input.criterionLine === 'number';

  // Items for the single collapsed bucket. Shaped like the call-graph byDepth
  // items (`{ depth, id, name, type, filePath, processes }`) so consumers that
  // iterate byDepth read the same fields. `unresolved` entries keep `id: null`
  // (surfaced under their file; `collectImpactSymbolUids` skips a null id, which
  // is correct — there is no symbol UID to attribute).
  const items = symbols.map((s) => ({
    depth: 1,
    id: s.id,
    name: s.name,
    type: s.type,
    filePath: s.filePath,
    ...(s.startLine !== undefined ? { startLine: s.startLine } : {}),
    ...(s.ambiguous ? { ambiguous: true } : {}),
    ...(s.id === null ? { unresolved: true } : {}),
    pdgEvidence: (s.id === null ? 'degraded' : 'owner-projection') as PdgImpactEvidence,
    pdgEvidenceReason:
      s.id === null
        ? 'reachable BasicBlock has no owning Function/Method/Constructor projection'
        : 'reachable BasicBlock projected to its owning symbol',
    processes: [] as unknown[],
  }));

  // impactedCount = distinct owning SYMBOLS (resolved UIDs). Unresolved shadow
  // entries are surfaced in byDepth but do NOT inflate the symbol count.
  const resolvedUids = new Set(symbols.filter((s) => s.id !== null).map((s) => s.id as string));
  const impactedCount = resolvedUids.size;

  const byDepth: Record<number, unknown[]> = items.length > 0 ? { 1: items } : {};
  const byDepthCounts: Record<number, number> = { 1: items.length };

  const noteParts: string[] = statementMode
    ? [
        `mode:'pdg' — intra-procedural slice from line ${input.criterionLine} of ` +
          `'${target.name}'. ${affectedStatements.length} ` +
          `${affectedStatements.length === 1 ? 'statement is' : 'statements are'} ${direction}-` +
          `dependent on it (over CDG + REACHING_DEF). Inter-procedural symbol reach ` +
          `is attached by impact mode's unified PDG dispatcher in interproceduralByDepth/byDepth.`,
      ]
    : [
        `mode:'pdg' — intra-procedural Program Dependence Graph. ${impactedCount} owning ` +
          `${impactedCount === 1 ? 'symbol' : 'symbols'} reached via ${reachableBlocks.length} ` +
          `dependence ${reachableBlocks.length === 1 ? 'block' : 'blocks'} ` +
          `(${direction} over CDG + REACHING_DEF). Inter-procedural symbol reach ` +
          `is attached by impact mode's unified PDG dispatcher in interproceduralByDepth/byDepth.`,
      ];
  if (ambiguousCount > 0) {
    noteParts.push(
      `${ambiguousCount} owning-symbol ${ambiguousCount === 1 ? 'projection is' : 'projections are'} ` +
        `ambiguous: same-line functions cannot be disambiguated by start line alone (no startColumn ` +
        `in the schema), so ALL colliding symbols are reported — none is silently picked.`,
    );
  }
  if (unresolvedCount > 0) {
    noteParts.push(
      `${unresolvedCount} reachable ${unresolvedCount === 1 ? 'block maps' : 'blocks map'} to no ` +
        `owning Function/Method/Constructor (top-level statement or a lambda whose start line is not a symbol ` +
        `start) — surfaced under their file as 'unresolved', never dropped.`,
    );
  }

  return {
    mode: 'pdg',
    target,
    direction,
    impactedCount,
    // KTD8: reuse the existing UNKNOWN sentinel — never a confident LOW (which
    // would read as "safe to refactor"; #2129/#1858 false-safe lineage). PDG
    // mode is intra-procedural, so its count is a per-function lower bound on the
    // true blast radius and risk is genuinely UNKNOWN at the program level.
    risk: 'UNKNOWN',
    // PDG-specific epistemic marker — NOT the callgraph 'lower-bound'/DI copy.
    epistemic: 'pdg-intra-procedural',
    note: noteParts.join(' '),
    pdgEvidence: {
      statements: 'local-dependence',
      localSymbols: unresolvedCount > 0 ? 'degraded' : 'owner-projection',
      localSymbolCount: impactedCount,
      unresolvedBlockCount: unresolvedCount,
      ambiguousProjectionCount: ambiguousCount,
    },
    // Statement-level slice: the dependent source statements (line + text) the
    // change reaches. This is the primary useful output of statement mode; the
    // accuracy harness scores against these lines.
    ...(statementMode ? { criterionLine: input.criterionLine } : {}),
    affectedStatements,
    affectedStatementCount: affectedStatements.length,
    // Raw block-level detail retained alongside the symbol projection (U3 tests
    // and the accuracy harness read these).
    reachableBlocks,
    seedBlocks: input.seedBlocks,
    blockCount: reachableBlocks.length,
    depthReached: input.depthReached,
    unresolvedBlockCount: unresolvedCount,
    ambiguousProjectionCount: ambiguousCount,
    ...(input.truncated ? { truncated: true } : {}),
    ...(input.truncatedBy ? { truncatedBy: input.truncatedBy } : {}),
    ...(input.truncatedByReasons ? { truncatedByReasons: input.truncatedByReasons } : {}),
    summary: {
      direct: impactedCount,
      processes_affected: 0,
      modules_affected: 0,
    },
    byDepthCounts,
    affected_processes: [] as unknown[],
    affected_modules: [] as unknown[],
    byDepth,
  };
}

/** The two impact engines (KTD1). `'callgraph'` is the default/established path. */
export type ImpactMode = 'callgraph' | 'pdg';

/**
 * Validate the `impact` `mode` param (KTD5 — backend hard-gate).
 *
 * The MCP JSON-schema `enum` is advisory only (server.ts forwards args
 * unvalidated and `callTool` is reachable directly), so this backend check is
 * the real boundary — mirroring `_pdgQueryImpl`'s `mode` enum validation. A
 * typo'd mode silently running callgraph is exactly the silent fallback this
 * forbids (it would make the accuracy harness compare callgraph-vs-callgraph
 * and report perfect parity).
 *
 * Absent / `undefined` / `'callgraph'` all resolve to `'callgraph'` (the
 * unchanged default path). `'pdg'` is valid. Anything else — `'PDG'`, `'pgd'`,
 * `''`, or a non-string (`0`, `null`, …) — returns a structured `{ error }`,
 * never a callgraph result.
 */
export function validateImpactMode(rawMode: unknown): { mode: ImpactMode } | { error: string } {
  if (rawMode === undefined || rawMode === 'callgraph') return { mode: 'callgraph' };
  if (rawMode === 'pdg') return { mode: 'pdg' };
  return {
    error: `Invalid "mode": expected "callgraph" or "pdg", got ${JSON.stringify(rawMode)}.`,
  };
}

/** The two independently-stamped PDG sub-layers (KTD7). */
export type PdgSubLayer = 'CDG' | 'REACHING_DEF';

/**
 * Four-state PDG-layer presence/degradation status (KTD7).
 *
 * - `'no-layer'`         — `meta.pdg` is absent: this repo was never analyzed
 *                          with `--pdg` (definitive; established with NO DB scan).
 * - `'sub-layer-missing'`— exactly one of the two independently-stamped caps
 *                          (`maxCdgEdgesPerFunction` / `maxReachingDefEdgesPerFunction`)
 *                          is present. `impact`'s PDG mode needs BOTH, so a
 *                          partial layer must not be reported as complete; the
 *                          missing one is named in `missingSubLayer`.
 * - `'ready'`            — both caps present: the layer is fully stamped.
 * - `'unknown'`          — meta is unreadable (e.g. a seeded test DB with no
 *                          `meta.json`). One bounded `LIMIT 1` probe distinguishes
 *                          a genuinely edge-free index from a missing one; either
 *                          way the conclusion is inconclusive (a missing layer is
 *                          indistinguishable from an all-linear one — #2188).
 */
export interface PdgLayerStatus {
  state: 'no-layer' | 'sub-layer-missing' | 'ready' | 'unknown';
  /** Set only for `'sub-layer-missing'` — the cap that was NOT stamped. */
  missingSubLayer?: PdgSubLayer;
  /** Human-readable guidance for the degraded states (absent for `'ready'`). */
  note?: string;
  /** Set when an unknown-state probe failed before it could inspect PDG rows. */
  probeError?: string;
  /** Optional operator-facing recovery hint for probe failures. */
  recoverySuggestion?: string;
}

/**
 * Per-cap presence read from `meta.pdg`, plus whether meta was readable at all.
 *
 * `metaReadable` is the seam between the `'unknown'` state (meta unreadable —
 * fall through to a DB probe) and the meta-stamped states. When `metaReadable`
 * is true but `meta.pdg` was absent, both `cdg`/`rd` are `false`.
 */
interface PdgMetaCaps {
  metaReadable: boolean;
  /** `maxCdgEdgesPerFunction !== undefined` (only meaningful when metaReadable). */
  cdg: boolean;
  /** `maxReachingDefEdgesPerFunction !== undefined` (only meaningful when metaReadable). */
  rd: boolean;
}

/**
 * Read the two PDG sub-layer caps from the on-disk `meta.json` stamp — the
 * single shared meta-probe both `_pdgQueryImpl` (one cap) and the PDG impact
 * mode (both caps) key on. Never scans the DB. An unreadable / missing meta
 * yields `metaReadable: false` (the `'unknown'` seam); a readable meta with no
 * `pdg` stamp yields `metaReadable: true` with both caps `false` (no-layer).
 */
async function readPdgMetaCaps(
  lbugPath: string,
  loadMetaFn: typeof loadMeta,
): Promise<PdgMetaCaps> {
  try {
    const meta = await loadMetaFn(path.dirname(lbugPath));
    if (!meta) return { metaReadable: false, cdg: false, rd: false };
    return {
      metaReadable: true,
      cdg: meta.pdg?.maxCdgEdgesPerFunction !== undefined,
      rd: meta.pdg?.maxReachingDefEdgesPerFunction !== undefined,
    };
  } catch {
    // Meta unreadable — the caller decides from the DB (the `'unknown'` state).
    return { metaReadable: false, cdg: false, rd: false };
  }
}

/**
 * Project the both-caps PDG meta read down to the single mode-relevant cap that
 * `_pdgQueryImpl` keys on (`controls` → CDG, `flows` → REACHING_DEF), preserving
 * its established tri-state `boolean | undefined` contract byte-for-byte
 * (Feasibility Issue 4):
 *   - `false`     — meta readable and the relevant cap absent → definitive
 *                   no-layer (short-circuits before any DB scan).
 *   - `true`      — meta readable and the relevant cap present → proceed.
 *   - `undefined` — meta unreadable → defer to the post-anchored-query probe.
 *
 * `_pdgQueryImpl` needs only ONE cap, so it collapses the both-caps read here
 * rather than consuming `pdgLayerStatus` directly (whose `'unknown'` state does
 * an upfront global probe — wrong timing/order for the anchored-query path).
 */
export async function pdgStampForMode(
  lbugPath: string,
  mode: 'controls' | 'flows',
  loadMetaFn: typeof loadMeta = loadMeta,
): Promise<boolean | undefined> {
  const caps = await readPdgMetaCaps(lbugPath, loadMetaFn);
  if (!caps.metaReadable) return undefined;
  return mode === 'controls' ? caps.cdg : caps.rd;
}

/**
 * PDG-layer presence/degradation check for the `impact` PDG mode (KTD7).
 *
 * Returns the four distinct states WITHOUT scanning the DB except for the single
 * bounded `LIMIT 1` probe the `'unknown'` (meta-unreadable) case requires. The
 * caller (`_impactImpl` PDG branch, and the accuracy harness) surfaces a
 * distinct signal per state so a missing `--pdg` layer / partial layer is never
 * silently misread as a confident empty blast radius. Impact needs BOTH the CDG
 * and the REACHING_DEF sub-layer, so a partial stamp degrades, not proceeds.
 */
export async function pdgLayerStatus(deps: {
  lbugPath: string;
  executeParameterized: typeof executeParameterized;
  loadMetaFn?: typeof loadMeta;
}): Promise<PdgLayerStatus> {
  const loadMetaFn = deps.loadMetaFn ?? loadMeta;
  const caps = await readPdgMetaCaps(deps.lbugPath, loadMetaFn);

  if (caps.metaReadable) {
    // Meta is readable — the stamp is authoritative, no DB scan needed.
    if (caps.cdg && caps.rd) return { state: 'ready' };
    if (caps.cdg !== caps.rd) {
      // Exactly one sub-layer stamped (XOR) — partial layer; impact needs both.
      const missingSubLayer: PdgSubLayer = caps.cdg ? 'REACHING_DEF' : 'CDG';
      return {
        state: 'sub-layer-missing',
        missingSubLayer,
        note:
          `PDG layer is incomplete — the ${missingSubLayer} sub-layer is missing ` +
          `(impact's PDG mode needs both CDG and REACHING_DEF). ` +
          `Re-run gitnexus analyze --pdg to record it.`,
      };
    }
    // Neither cap stamped (meta.pdg absent, or present with no caps) → the layer
    // was never recorded. Definitive, no DB scan.
    return {
      state: 'no-layer',
      note: 'no PDG layer — run gitnexus analyze --pdg to record CDG + REACHING_DEF edges for this repo',
    };
  }

  // Meta unreadable (e.g. a seeded test DB): one bounded probe confirms the
  // layer status is genuinely undeterminable from the DB. A missing layer is
  // indistinguishable from an all-linear (edge-free) one (#2188), so whether the
  // probe finds a row or not the state stays `'unknown'` (never the definitive
  // no-layer wording). The probe is bounded (`LIMIT 1`) and anchored on the
  // BasicBlock→BasicBlock partition (the `(:BasicBlock)…(:BasicBlock)` label pair
  // restricts it to the sparse pdg-edge partition, never a global rel scan — the
  // established `_explainImpl` anchoring pattern), and it is wrapped so a db-lock
  // / missing-path throw degrades to the same `'unknown'` signal rather than
  // propagating and losing it.
  //
  // The probe result is NOT discarded: a visible CDG/REACHING_DEF edge (with
  // meta unreadable) is a weak-but-real "edges are present, but completeness is
  // unprovable" signal, distinct from "no edges visible at all". Both stay
  // `'unknown'` (inconclusive), but the note distinguishes them so the operator
  // gets the more useful hint.
  let edgesVisible = false;
  let probeError: string | undefined;
  try {
    const rows = await deps.executeParameterized(
      deps.lbugPath,
      `MATCH (:BasicBlock)-[r:CodeRelation]->(:BasicBlock) WHERE r.type IN ['CDG', 'REACHING_DEF'] RETURN r.type AS type LIMIT 1`,
      {},
    );
    edgesVisible = Array.isArray(rows) && rows.length > 0;
  } catch (err) {
    // db-lock / missing-path / corrupt probe — fall through as not-visible, but
    // keep the `'unknown'` signal AND preserve the probe failure. Reporting the
    // failed probe as "no edges visible" hides a DB-health problem from operators.
    probeError = err instanceof Error ? err.message : String(err);
    edgesVisible = false;
  }
  if (probeError) {
    return {
      state: 'unknown',
      probeError,
      recoverySuggestion:
        'Check for a LadybugDB lock/corruption or missing index path. Stop overlapping GitNexus processes, retry, or re-run gitnexus analyze --pdg.',
      note:
        `PDG layer status unknown — CDG/REACHING_DEF probe failed: ${probeError}. ` +
        `The layer cannot be confirmed complete; this is distinct from "no edges visible".`,
    };
  }
  return {
    state: 'unknown',
    note: edgesVisible
      ? 'PDG layer status unknown — CDG/REACHING_DEF edges ARE visible but meta is unreadable, so the layer cannot be confirmed complete (a partial layer looks the same); was this repo fully indexed with gitnexus analyze --pdg?'
      : 'PDG layer status unknown — no CDG/REACHING_DEF edges visible and meta is unreadable; was this repo indexed with gitnexus analyze --pdg?',
  };
}

/**
 * Build the SAME BasicBlock seed anchor (`anchorClause` + `queryParams`) as
 * `resolveBlockAnchor`'s symbol branch, but from an ALREADY-RESOLVED symbol —
 * WITHOUT re-running `resolveSymbolCandidates`.
 *
 * Why this exists (correctness keystone): `_impactImpl` already resolves the
 * target to a confident single symbol honoring the caller's
 * `target_uid`/`file_path`/`kind` hints. Re-resolving by the bare `sym.name`
 * inside `_runImpactPDG` would (a) RE-AMBIGUATE a globally-ambiguous name the
 * caller had disambiguated (returning the "ambiguous" early payload instead of
 * the PDG result), or (b) anchor the seed on a DIFFERENT same-name symbol in
 * another file → a wrong-symbol blast radius. Anchoring directly from the
 * resolved `{ filePath, startLine, endLine }` preserves the disambiguation.
 *
 * The window is byte-identical to `resolveBlockAnchor`'s symbol branch: BOTH
 * span bounds are shifted `+1` (1-based BasicBlock `startLine` vs the 0-based
 * symbol span — the lower `+1` excludes a neighbor's block on the line above,
 * the upper `+1` keeps a guard/def/use on the final line). A symbol with no
 * usable span degrades to the same file-level id-prefix filter. This is the
 * resolved-symbol counterpart, NOT a second window convention.
 */
function blockAnchorForResolvedSymbol(sym: {
  filePath: string;
  startLine?: number;
  endLine?: number;
}): { anchorClause: string; queryParams: Record<string, unknown> } {
  const idPrefix = `BasicBlock:${sym.filePath}:`;
  if (
    typeof sym.startLine === 'number' &&
    typeof sym.endLine === 'number' &&
    sym.endLine >= sym.startLine
  ) {
    return {
      anchorClause:
        'a.id STARTS WITH $idPrefix AND a.startLine >= $symStart AND a.startLine <= $symEnd',
      queryParams: { idPrefix, symStart: sym.startLine + 1, symEnd: sym.endLine + 1 },
    };
  }
  return { anchorClause: 'a.id STARTS WITH $idPrefix', queryParams: { idPrefix } };
}

/**
 * Build a STATEMENT seed anchor: the BasicBlock(s) starting at a specific
 * 1-based source `line` WITHIN the resolved symbol. This is what makes
 * `mode:'pdg'` useful — seeding the dependence slice on a single statement
 * (the thing being changed) rather than the whole symbol. A whole-symbol seed
 * captures every intra-procedural block, so the reachable-minus-seed set is
 * empty (all intra reach is within the seed); a statement seed leaves the
 * other dependent statements reachable. `BasicBlock.startLine` is 1-based and
 * matches the source line, so no `+1` offset applies here (unlike the symbol
 * span, where the 0-based symbol bounds are shifted). Bounded to the symbol's
 * own span when known, so a line shared with a sibling symbol can't leak.
 */
function blockAnchorForStatement(
  sym: { filePath: string; startLine?: number; endLine?: number },
  line: number,
): { anchorClause: string; queryParams: Record<string, unknown> } {
  const idPrefix = `BasicBlock:${sym.filePath}:`;
  if (
    typeof sym.startLine === 'number' &&
    typeof sym.endLine === 'number' &&
    sym.endLine >= sym.startLine
  ) {
    return {
      anchorClause:
        'a.id STARTS WITH $idPrefix AND a.startLine = $line AND a.startLine >= $symStart AND a.startLine <= $symEnd',
      queryParams: { idPrefix, line, symStart: sym.startLine + 1, symEnd: sym.endLine + 1 },
    };
  }
  return {
    anchorClause: 'a.id STARTS WITH $idPrefix AND a.startLine = $line',
    queryParams: { idPrefix, line },
  };
}

export interface RunPdgImpactDeps {
  repo: { lbugPath: string };
  sym: { id: string; name: string; filePath: string; startLine?: number; endLine?: number };
  symType: string;
  direction: 'upstream' | 'downstream';
  maxDepth: number;
  limit: number;
  /** Statement anchor (1-based source line). */
  line?: number;
  executeParameterized: typeof executeParameterized;
}

export async function runImpactPDG(deps: RunPdgImpactDeps): Promise<PdgImpactResult> {
  const { repo, sym, direction, maxDepth, line, executeParameterized: exec } = deps;
  // `line` present ⇒ statement-anchored slice (the useful mode); absent ⇒
  // whole-symbol seed (intra-procedural reach collapses to empty for a
  // function — kept for back-compat, with a note steering the caller to `line`).
  const statementMode = typeof line === 'number' && Number.isInteger(line) && line >= 1;
  // `target` carries the call-graph-compatible shape (id/name/type/filePath) so
  // `collectImpactSymbolUids` keys on it identically to a callgraph result.
  const target = {
    id: sym.id,
    name: sym.name,
    type: deps.symType || 'Function',
    filePath: sym.filePath,
  };

  // Validate the per-step LIMIT as a positive integer (KTD11 — interpolated,
  // so it must be sanitised, never user-string-passed). A non-integer / out-of
  // range value (NaN, 1.5, negative, huge) is CLAMPED to the bounded default
  // rather than rejected: impact's `limit` is a soft page hint, and a clamp
  // keeps the safety tool producing a (flagged-bounded) radius instead of a
  // hard error. The clamp ceiling matches `pdg_query`'s validated max.
  const rawLimit = deps.limit;
  const stepLimit =
    Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= PDG_QUERY_MAX_LIMIT
      ? rawLimit
      : PDG_QUERY_DEFAULT_LIMIT;
  // Depth: clamp to the documented impact server max. The BFS issues one DB
  // query per depth level, so direct callTool callers must not bypass the
  // schema's maxDepth cap.
  const depthBudget =
    Number.isInteger(maxDepth) && maxDepth >= 1 ? Math.min(maxDepth, IMPACT_MAX_DEPTH) : 3;

  // ── Seed: anchor the target's BasicBlocks from the ALREADY-RESOLVED symbol ─
  // `_impactImpl` already resolved `sym` to a confident single match honoring
  // the caller's target_uid/file_path/kind hints. Re-resolving by the bare
  // `sym.name` here would RE-AMBIGUATE a disambiguated name (returning the
  // "ambiguous" early payload instead of the PDG result) or anchor the seed on
  // a DIFFERENT same-name symbol in another file (wrong-symbol blast radius).
  // So build the seed anchor DIRECTLY from the resolved symbol's
  // [startLine+1, endLine+1] window — the same window `resolveBlockAnchor`'s
  // symbol branch produces, without re-running `resolveSymbolCandidates`.
  const { anchorClause, queryParams } = statementMode
    ? blockAnchorForStatement(sym, line as number)
    : blockAnchorForResolvedSymbol(sym);

  const probeLimit = stepLimit + 1;
  const rawSeedRows = await exec(
    repo.lbugPath,
    `MATCH (a:BasicBlock) WHERE ${anchorClause} RETURN a.id AS id LIMIT ${probeLimit}`,
    queryParams,
  );
  const seedRows = rawSeedRows.slice(0, stepLimit);
  const seedBlocks: string[] = seedRows
    .map((r: any) => String(r.id ?? r[0] ?? ''))
    .filter((id: string) => id.length > 0);
  // FIX 7: the seed query probes one row past `stepLimit`, then processes at
  // most `stepLimit` rows like every BFS step. A function with more seed blocks
  // than `stepLimit` would silently under-seed (and thus under-report) — flag
  // it so the result carries the same truncation
  // signal the BFS steps do, never a silent partial seed.
  const seedTruncated = rawSeedRows.length > stepLimit;

  // ── KTD6 no-body contract: distinguish "no PDG body" from "no dependence" ──
  // A symbol that resolves but produces ZERO anchored blocks has no CFG body
  // (interface / type alias / abstract / ambient / one-line const). A bare
  // impactedCount:0 / risk:'LOW' would read as "safe to refactor" — the exact
  // false-safe `impact` exists to prevent (#2129/#1858). Surface an explicit
  // note + a non-LOW epistemic marker, never a silent confident zero.
  if (seedBlocks.length === 0) {
    return {
      mode: 'pdg',
      target,
      direction,
      ...(statementMode ? { criterionLine: line } : {}),
      reachableBlocks: [],
      seedBlocks: [],
      blockCount: 0,
      affectedStatements: [],
      affectedStatementCount: 0,
      truncated: false,
      depthReached: 0,
      // statementMode: the requested line has no statement block inside the
      // symbol (blank line, comment, outside the body, or a line the CFG did
      // not materialise). Distinct from "no PDG body".
      epistemic: statementMode ? 'pdg-no-block-at-line' : 'no-pdg-body',
      note: statementMode
        ? `No PDG statement block starts at line ${line} within '${sym.name}' ` +
          `(${sym.filePath}). The line may be blank, a comment, a brace, or outside ` +
          `the symbol's body. Pass a line that begins an executable statement.`
        : `'${sym.name}' has no PDG body — no BasicBlocks / control- or data-dependence ` +
          `edges exist for this symbol (e.g. an interface, type alias, abstract/ambient ` +
          `member, or a one-line declaration with no CFG). This is NOT a confident ` +
          `"no impact": the local PDG statement slice cannot model this symbol kind. ` +
          `Inter-procedural symbol reach may still be attached by the unified impact dispatcher.`,
      impactedCount: 0,
      risk: 'UNKNOWN',
      // KTD8 parity fields so a consumer iterating byDepth / reading the
      // depth counts on a no-body result still finds a well-formed (empty)
      // shape rather than `undefined` (which would render as "isolated").
      ...emptyPdgParityFields(),
      unresolvedBlockCount: 0,
      ambiguousProjectionCount: 0,
    };
  }

  // ── Bounded direction-aware BFS over CDG + REACHING_DEF (KTD4, KTD11) ──────
  // Seed blocks are NOT counted as reachable (they ARE the target); the
  // reachable set is everything the BFS discovers from them. Visited tracks
  // BOTH seeds and discovered blocks so a cycle never re-expands.
  const visited = new Set<string>(seedBlocks);
  const reachable = new Set<string>();
  let frontier = [...seedBlocks];
  let depthReached = 0;
  // `truncatedByDepth`: the BFS still had a non-empty frontier when the depth
  // budget ran out (more reachable blocks exist past `maxDepth`).
  // `truncatedByLimit`: a single step's neighbour query hit the one-past
  // LIMIT probe, so that step's expansion is a lower bound. The SEED query is
  // one-past-probed too, so `seedTruncated` seeds this flag — a partial seed is
  // a lower-bound expansion just like a partial step. Either flags `truncated`.
  let truncatedByDepth = false;
  let truncatedByLimit = seedTruncated;

  // The endpoint the frontier is matched on, and the endpoint collected, flip
  // by direction — but the SAME sense applies to BOTH edge types (KTD4).
  //   downstream: frontier = source `a`, collect target `b`  (forward)
  //   upstream:   frontier = target `b`, collect source `a`  (reverse)
  const matchEndpoint = direction === 'downstream' ? 'a' : 'b';
  const collectEndpoint = direction === 'downstream' ? 'b' : 'a';

  for (let depth = 0; depth < depthBudget; depth++) {
    if (frontier.length === 0) break;
    // Anchored on exact frontier ids (bound as a param — KTD11). The edge-type
    // discriminator is a hardcoded literal list (never user input). `LIMIT` is
    // the validated integer `probeLimit` (one row past the processed page).
    const rawRows = await exec(
      repo.lbugPath,
      `MATCH (a:BasicBlock)-[r:CodeRelation]->(b:BasicBlock)
         WHERE r.type IN ['CDG', 'REACHING_DEF'] AND ${matchEndpoint}.id IN $frontier
         RETURN DISTINCT ${collectEndpoint}.id AS id
         LIMIT ${probeLimit}`,
      { frontier },
    );
    const rows = rawRows.slice(0, stepLimit);
    depthReached = depth + 1;
    if (rawRows.length > stepLimit) truncatedByLimit = true;

    const next: string[] = [];
    for (const r of rows) {
      const id = String((r as any).id ?? (r as any)[0] ?? '');
      if (!id || visited.has(id)) continue;
      visited.add(id);
      reachable.add(id);
      next.push(id);
    }
    frontier = next;
  }
  // Frontier still non-empty after exhausting the depth budget ⇒ more blocks
  // are reachable beyond `maxDepth` (depth truncation, distinct from natural
  // completion where the frontier drains to empty inside the loop).
  if (frontier.length > 0) truncatedByDepth = true;

  const reachableBlocks = [...reachable].sort();
  const truncated = truncatedByDepth || truncatedByLimit;
  const truncatedBy: 'depth' | 'limit' | undefined = truncatedByDepth
    ? 'depth'
    : truncatedByLimit
      ? 'limit'
      : undefined;
  const truncatedByReasons: readonly ('depth' | 'limit')[] | undefined =
    truncatedByDepth && truncatedByLimit ? (['depth', 'limit'] as const) : undefined;

  // ── Resolve the reachable blocks to source statements (line + text) ────────
  // This is the useful output of statement mode: the dependent statements the
  // change at `line` reaches. Fetched once for the whole reachable set; sorted
  // by line. Failure surfaces (no `.catch` swallow) rather than masquerading
  // as "no affected statements".
  const affectedStatements = await pdgStatementsForBlocks(repo.lbugPath, reachableBlocks, exec);

  // ── Has a PDG body but no intra-procedural dependence reachability ─────────
  // Distinct from "no PDG body": the function exists and has blocks, but no
  // CDG/REACHING_DEF edge leaves the target's blocks in this direction. For a
  // WHOLE-SYMBOL seed this is the expected (and uninformative) result — every
  // intra-procedural block is already a seed — so the note steers to `line`.
  // Still not a confident zero — explicit note + UNKNOWN (KTD6/KTD8).
  if (reachableBlocks.length === 0) {
    return {
      mode: 'pdg',
      target,
      direction,
      ...(statementMode ? { criterionLine: line } : {}),
      impactedCount: 0,
      risk: 'UNKNOWN',
      epistemic: 'pdg-intra-procedural',
      note: statementMode
        ? `No statement in '${sym.name}' is ${direction}-dependent on line ${line} ` +
          `(no CDG/REACHING_DEF reachability from that statement). The line may have no ` +
          `dependents in this direction.`
        : `'${sym.name}' has a PDG body but a WHOLE-SYMBOL ${direction} slice is empty: ` +
          `intra-procedural dependence stays inside the function, so every reachable block ` +
          `is already part of the seed. Pass line:<N> to slice from a specific statement ` +
          `(what depends on the code at that line). Inter-procedural symbol reach is attached ` +
          `separately by the unified impact dispatcher.`,
      reachableBlocks: [] as string[],
      // Carry the real seed blocks (non-empty here — the function HAS blocks, they
      // are all seeds): a callee invoked directly on the seeded line must still be
      // provable even when the line has no downstream dependents (the seed-line FN
      // the tri-review found). Empty reachableBlocks must NOT zero the seed callees.
      seedBlocks,
      blockCount: 0,
      affectedStatements: [],
      affectedStatementCount: 0,
      depthReached,
      unresolvedBlockCount: 0,
      ambiguousProjectionCount: 0,
      ...(truncated ? { truncated: true } : {}),
      ...(truncatedBy ? { truncatedBy } : {}),
      ...(truncatedByReasons ? { truncatedByReasons } : {}),
      ...emptyPdgParityFields(),
    };
  }

  // ── U4: project reachable blocks → owning symbols, assemble parity result ──
  const projection = await projectBlocksToSymbols({
    lbugPath: repo.lbugPath,
    blockIds: reachableBlocks,
    executeParameterized: exec,
  });

  return assemblePdgImpactResult({
    target: {
      id: sym.id,
      name: sym.name,
      type: deps.symType || 'Function',
      filePath: sym.filePath,
    },
    direction,
    reachableBlocks,
    seedBlocks,
    affectedStatements,
    criterionLine: statementMode ? (line as number) : undefined,
    projection,
    depthReached,
    truncated,
    truncatedBy,
    truncatedByReasons,
  });
}
