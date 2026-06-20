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
import { CALLEES_TRUNCATED_SENTINEL, CALLEE_ID_SEP } from '../../core/ingestion/cfg/emit.js';
import { decodeCallSummary } from '../../core/ingestion/taint/call-summary-codec.js';
import { decodeReachingDefReason } from '../../core/ingestion/cfg/reaching-def-reason-codec.js';
import { getProviderForFile } from '../../core/ingestion/languages/index.js';
import { SupportedLanguages } from 'gitnexus-shared';

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

/**
 * Default inter-procedural FUNCTION-hop budget for the U1 forward closure (the
 * number of call boundaries the slice descends through). Distinct from the per-
 * hop intra-callee step/edge budget (which reuses `stepLimit`). Kept small (3)
 * because context-insensitive descent over-includes with depth.
 */
const INTERPROC_DEPTH_BUDGET = 3;

/**
 * Total newly-reached-block cap across all inter-procedural hops — the secondary
 * termination guard against a pathological fan-out inside the depth budget.
 * Stamps `truncated` with the `'limit'` reason when it fires (it is a SIZE/budget
 * cap, not dependence-level depth exhaustion — FIX 7).
 */
const INTERPROC_NODE_BUDGET = 5000;

/**
 * Split a tab-joined ({@link CALLEE_ID_SEP}) `BasicBlock.calleeIds` cell into its resolved callee
 * symbol ids, dropping the truncation sentinel (a capped block carries the
 * sentinel to mark an incomplete call-site list; it is NOT a resolved symbol id
 * and must never enter a `has(realId)` set). Empty/whitespace cells yield no ids.
 *
 * Extracted here (U1) so the two callers — `LocalBackend.calleeIdsOfBlocks` (the
 * statement-precise bridge key) and the inter-procedural descent's
 * `calleeIdsFromCalleeRows` — cannot diverge on the split-and-drop-sentinel
 * logic. Both consume rows of `BasicBlock.calleeIds`; this is the single source.
 */
export function splitCalleeIds(raw: unknown): string[] {
  const out: string[] = [];
  // Split on the SHARED CALLEE_ID_SEP (tab) — ids embed file paths / multi-word
  // C++ type tokens that can contain a space, so a space split would fragment
  // them. Producer (calleeIdsOfBlock) joins with the same constant.
  for (const id of String(raw ?? '').split(CALLEE_ID_SEP)) {
    if (id && id !== CALLEES_TRUNCATED_SENTINEL) out.push(id);
  }
  return out;
}

/**
 * Contract version of the mode:'pdg' impact result shape. A stable discriminator
 * for external MCP/agent consumers — distinct from the DB INCREMENTAL_SCHEMA_VERSION.
 * Bump on any breaking change to the PDG result fields.
 */
export const PDG_RESULT_VERSION = 1 as const;

/** A reachable dependence block resolved to its source statement. */
export interface PdgStatement {
  /** 1-based source line where the statement's block starts. */
  line: number;
  /** Repo-relative file path (parsed from the block id). */
  filePath: string;
  /** The statement's source text (BasicBlock.text), trimmed. */
  text: string;
  /**
   * Whether the statement belongs to the criterion's OWN function (`'intra'`)
   * or was reached across a call boundary (`'inter'`). A block is `'intra'`
   * iff its owning-fn file AND 1-based owning-fn start line both match the
   * criterion's — `fnFileOf(id) === criterionFile && fnLineOf(id) === ownerFnLine`.
   * Projection-only tag (FU-A): NOT persisted, NOT a schema field. The bench
   * intra axis scopes to `'intra'` statements so U1's cross-function reach
   * stops being counted as intra-axis false positives; existing consumers
   * ignore it.
   */
  scope: 'intra' | 'inter';
}

/**
 * FU-B-2 intra-block def→use line walk. Given a block's self REACHING_DEF
 * def→use line PAIRS (every `defLine → useLine` step decoded from the edge
 * `reason`'s pair list), walk FORWARD from a set of entry lines and return every
 * interior USE line transitively reached. This is the principled statement-
 * granular recovery for a coalesced straight-line BasicBlock, for BOTH chain
 * shapes:
 *  - DISTINCT bindings: `chainCompute` coalesces `a@7; b@8; c@9` into one block;
 *    each binding is its own (block-pair, binding) group, so `a@7→b@8` and
 *    `b@8→c@9` arrive as separate self-edges, and walking from line 7 recovers
 *    {8, 9}.
 *  - SAME binding (reassignment): `acc = f(acc); acc = g(acc); acc = h(acc)`
 *    coalesces into one self-block whose `acc@24→acc@25`, `acc@25→acc@26`,
 *    `acc@26→acc@27` steps ALL share the one (self-block, accIdx) group — the
 *    dedup collapses them onto one edge, but the FU-B-2 pair LIST carries all
 *    three, so walking from line 24 chains 24→25→26→27 to fixpoint. (A
 *    first-pair-only annotation would stop at 25.)
 *
 * Pure: forward adjacency `defLine → Set<useLine>`, BFS from `entryLines`,
 * bounded by the (finite) pair set + a `reached` set so it always terminates,
 * even on a cycle — a self-referential line (`x = x + 1`, def@L→use@L) re-adds
 * nothing new. The entry lines themselves are NOT emitted (they are the seed /
 * the block's representative line already surfaced elsewhere); only newly-reached
 * interior use lines are.
 */
function walkIntraBlockChain(
  selfEdges: ReadonlyArray<{ defLine: number; useLine: number }>,
  entryLines: Iterable<number>,
): Set<number> {
  const succ = new Map<number, Set<number>>();
  for (const { defLine, useLine } of selfEdges) {
    if (!Number.isInteger(defLine) || !Number.isInteger(useLine)) continue;
    const set = succ.get(defLine) ?? new Set<number>();
    set.add(useLine);
    succ.set(defLine, set);
  }
  const reached = new Set<number>();
  const frontier: number[] = [];
  for (const e of entryLines) frontier.push(e);
  const seenSeed = new Set<number>(frontier);
  while (frontier.length > 0) {
    const cur = frontier.pop() as number;
    for (const next of succ.get(cur) ?? []) {
      if (reached.has(next) || seenSeed.has(next)) continue;
      reached.add(next);
      frontier.push(next);
    }
  }
  return reached;
}

/**
 * Fetch the self REACHING_DEF edges (`(a)-[REACHING_DEF]->(a)`) for a set of
 * blocks, grouped by block id, with each edge's def/use source LINES decoded
 * from the FU-B-2 `reason` annotation (`<name>|1:<defLine>:<useLine>`). A
 * pre-FU-B-2 (un-annotated) `reason` decodes to no line info → the edge is
 * dropped (the block then projects at block-start granularity exactly as before,
 * the documented graceful degrade for an older index). A query error propagates.
 */
async function selfReachingDefEdgesByBlock(
  lbugPath: string,
  blockIds: string[],
  exec: typeof executeParameterized,
): Promise<Map<string, Array<{ defLine: number; useLine: number }>>> {
  const out = new Map<string, Array<{ defLine: number; useLine: number }>>();
  if (blockIds.length === 0) return out;
  const rows = await exec(
    lbugPath,
    `MATCH (a:BasicBlock)-[r:CodeRelation]->(a)
       WHERE r.type = 'REACHING_DEF' AND a.id IN $ids
       RETURN a.id AS id, r.reason AS reason`,
    { ids: blockIds },
  );
  for (const r of rows as Array<Record<string, unknown>>) {
    const id = String(r['id'] ?? '');
    if (!id) continue;
    const decoded = decodeReachingDefReason(r['reason']);
    // FU-B-2: the annotation carries the FULL ordered (defLine, useLine) pair
    // list for this (block-pair, binding) group — push EVERY pair so the walk can
    // chain a same-binding reassignment (`acc@24->acc@25->acc@26`), which the
    // dedup coalesces onto this one edge. A pre-FU-B-2 (un-annotated) reason
    // decodes to no pairs → contributes nothing (block-start granularity).
    if (decoded.pairs.length === 0) continue;
    const list = out.get(id) ?? [];
    for (const p of decoded.pairs) list.push({ defLine: p.defLine, useLine: p.useLine });
    out.set(id, list);
  }
  return out;
}

/**
 * Resolve a set of BasicBlock ids to their source statements (line + text),
 * deduped by `(filePath, line, block id)` and sorted by line. This is the useful
 * output of a statement-anchored PDG slice — the dependent statements the change
 * reaches. A query error propagates (no `.catch` swallow) so a DB failure is
 * never silently reported as "no affected statements".
 *
 * FU-B-2 statement granularity: a coalesced straight-line BasicBlock is projected
 * to its single `startLine` by default, which UNDER-reports the interior
 * statements that genuinely depend on the criterion (lines 8/9 of a `7-9` block).
 * For each block in `chainWalkBlocks` we walk its self REACHING_DEF def→use LINE
 * chain (decoded from the FU-B-2 `reason` annotation) FORWARD from that block's
 * entry line(s) and emit one statement per reached INTERIOR line (its own text
 * from the block text). This is the SINGLE principled statement-granular
 * mechanism — it replaces FU-C's blind all-interior-lines expansion of ascent
 * blocks (now routed through the same walk, seeded at the block's start line) and
 * also recovers the seed block's own interior dependents (the U2/intra-dataflow-
 * chain recall gap). A pre-FU-B-2 index (no line annotation) yields no self-edge
 * lines → the block degrades to its block-start projection (byte-identical to the
 * old behavior).
 */
async function pdgStatementsForBlocks(
  lbugPath: string,
  blockIds: string[],
  exec: typeof executeParameterized,
  criterionFile: string,
  ownerFnLine: number,
  /**
   * Blocks whose interior should be expanded to statement granularity via the
   * self-edge def→use line walk, each mapped to the entry line(s) the walk
   * starts from. Two contributors:
   *  - the SEED block, seeded at the criterion line — recovers the interior
   *    dependents of the changed statement inside its own coalesced block (the
   *    U2 intra-dataflow-chain gap: line 7's block 7-9 yields {8,9});
   *  - each U-C4 ascent-confirmed CALL block, seeded at its start line — the
   *    statement-granular realisation of the return-value ascent (replacing the
   *    FU-C blind interior-line stop-gap with the principled walk).
   * Empty/absent ⇒ every block projects at block-start granularity (byte-
   * identical to the pre-FU-B-2 behavior).
   */
  chainWalkBlocks: ReadonlyMap<string, ReadonlySet<number>> = new Map(),
): Promise<PdgStatement[]> {
  if (blockIds.length === 0 && chainWalkBlocks.size === 0) return [];
  // The seed block(s) we walk are NOT in `blockIds` (seeds are excluded from the
  // reachable slice), so the block-text fetch must cover BOTH the reachable
  // blocks and the chain-walk blocks. Union, de-duplicated.
  const fetchIds = [...new Set([...blockIds, ...chainWalkBlocks.keys()])];
  const [rows, selfEdgesByBlock] = await Promise.all([
    exec(
      lbugPath,
      `MATCH (b:BasicBlock) WHERE b.id IN $ids
       RETURN b.id AS id, b.startLine AS line, b.endLine AS endLine, b.text AS text`,
      { ids: fetchIds },
    ),
    chainWalkBlocks.size > 0
      ? selfReachingDefEdgesByBlock(lbugPath, [...chainWalkBlocks.keys()], exec)
      : Promise.resolve(new Map<string, Array<{ defLine: number; useLine: number }>>()),
  ]);
  const byKey = new Map<string, PdgStatement>();
  const reachableIds = new Set(blockIds);
  // Narrow the awaited rows ONCE at the boundary to a typed record shape; read
  // the aliased cells via bracket access with String()/Number() coercion.
  for (const r of rows as Array<Record<string, unknown>>) {
    const id = String(r['id'] ?? '');
    const line = Number(r['line'] ?? 0);
    if (!id || !Number.isFinite(line) || line <= 0) continue;
    const filePath = fnFileOf(id);
    const text = String(r['text'] ?? '').trim();
    // INTRA iff this block's owning function (file + 1-based start line) is the
    // criterion's own function; otherwise it was reached across a call boundary
    // (INTER). Pure key comparison parsed from the block id — no extra DB query.
    const scope: 'intra' | 'inter' =
      filePath === criterionFile && fnLineOf(id) === ownerFnLine ? 'intra' : 'inter';
    const textLines = String(r['text'] ?? '').split('\n');
    // ── FU-B-2 chain-walk block: expand to its interior dependent lines ───────
    // Walk the block's self REACHING_DEF def→use LINE chain forward from the
    // entry line(s). Each reached interior line is a statement transitively
    // data-dependent on the entry (the chain the coalesced block lost). Emit it
    // with its own physical-line text (`BasicBlock.text` is `lines.join('\n')`,
    // 1-based from `startLine`). This is the principled replacement for FU-C's
    // blind all-interior expansion — only lines the def→use chain proves are
    // surfaced. A block that is ALSO a reachable block keeps its block-start
    // statement too (added below); the seed block (not reachable) contributes
    // ONLY its walked interior lines.
    const entryLines = chainWalkBlocks.get(id);
    if (entryLines !== undefined) {
      // An empty entry set means "seed from the block's own start line" — the
      // FU-C ascent blocks, whose call statements chain forward from the block
      // start (the caller does not know the start line at map-build time). A
      // non-empty set (the seed block, seeded at the criterion line) is used
      // verbatim. `line` is the resolved block start line for this row.
      const seeds = entryLines.size > 0 ? entryLines : new Set<number>([line]);
      const reached = walkIntraBlockChain(selfEdgesByBlock.get(id) ?? [], seeds);
      for (const ln of reached) {
        const idx = ln - line;
        if (idx < 0 || idx >= textLines.length) continue; // out of this block's text
        const lineText = textLines[idx].trim();
        const key = `${filePath}:${ln}:${id}`;
        if (!byKey.has(key)) byKey.set(key, { line: ln, filePath, text: lineText, scope });
      }
    }
    // A reachable block always surfaces its representative block-start statement.
    // A pure chain-walk seed block (not reachable) does NOT (its start line is
    // the criterion / the call block already surfaced elsewhere — only its
    // walked-forward dependents are new). When the reachable block is ALSO a
    // chain-walk block (a coalesced call block whose interior lines we expanded),
    // its block-start statement is surfaced at the SAME statement granularity —
    // the first physical line's own text, not the whole multi-statement block
    // text — so all of its statements are consistently single-line. A reachable
    // block that is NOT chain-walked keeps the full trimmed block text (byte-
    // identical to the pre-FU-B-2 projection).
    if (reachableIds.has(id)) {
      const key = `${filePath}:${line}:${id}`;
      const startText =
        entryLines !== undefined && textLines.length > 0 ? textLines[0].trim() : text;
      if (!byKey.has(key)) byKey.set(key, { line, filePath, text: startText, scope });
    }
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
      // Narrow the rows ONCE at the boundary to a typed record shape and read the
      // aliased cells via bracket access (with positional `['0']`… fallback for a
      // non-aliased row shape) — no per-field `as any`, matching the typed-row
      // pattern used elsewhere in this file (e.g. lines ~264, ~1309, ~1386).
      for (const r of rows as Array<Record<string, unknown>>) {
        resolved.push({
          id: String(r['id'] ?? r['0'] ?? ''),
          name: String(r['name'] ?? r['1'] ?? ''),
          type: String(r['label'] ?? r['2'] ?? 'Function'),
          filePath,
          startLine: Number(r['startLine'] ?? r['3'] ?? symStart),
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
  /** Contract version of the mode:'pdg' impact result shape; bump on any breaking change to the PDG result fields. */
  pdgResultVersion: 1;
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
  // Statement-precise (proven) inter-procedural reach lives ONLY under
  // `pdgInterprocedural` (the scoped namespace) — see PdgInterproceduralImpact.
  pdgInterprocedural?: PdgInterproceduralImpact;
  pdgEvidence?: PdgImpactEvidenceSummary;
}

/**
 * Slice-result fields shared verbatim by {@link PdgImpactSuccessResult} and
 * {@link PdgImpactEmptyResult}. Those two differ ONLY in their `epistemic`
 * discriminant (and the narrowed `target`, which must be re-declared on each to
 * override `PdgImpactBaseResult.target`), so every other slice field lives here
 * to keep the two in lockstep — a new slice field is added once, not twice.
 */
export interface PdgImpactSliceFields {
  reachableBlocks: string[];
  /**
   * INTRA-procedural reachable subset of `reachableBlocks` (the statement slice
   * BEFORE the U1 inter-procedural descent expanded it). The callgraph bridge
   * keys its "first-hop proven" set on this, NOT the interproc-expanded
   * `reachableBlocks` superset, so statementPrecision keeps its first-hop meaning
   * (FIX 6). Equals `reachableBlocks` when no hop crossed; empty for the
   * no-body / no-block-at-line empty returns.
   */
  intraReachableBlocks: string[];
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

export interface PdgImpactSuccessResult extends PdgImpactBaseResult, PdgImpactSliceFields {
  target: Required<PdgImpactTarget>;
  epistemic: 'pdg-intra-procedural';
}

export interface PdgImpactEmptyResult extends PdgImpactBaseResult, PdgImpactSliceFields {
  target: Required<PdgImpactTarget>;
  epistemic: 'no-pdg-body' | 'pdg-no-block-at-line' | 'pdg-intra-procedural';
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
  /** Contract version of the mode:'pdg' impact result shape; bump on any breaking change to the PDG result fields. */
  pdgResultVersion: 1;
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
    pdgResultVersion: PDG_RESULT_VERSION,
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
    pdgResultVersion: PDG_RESULT_VERSION,
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
   * INTRA-procedural reachable subset (before the U1 descent). Surfaced verbatim
   * so the callgraph bridge keys its "first-hop proven" set on the original
   * statement slice, not the interproc-expanded superset (FIX 6).
   */
  intraReachableBlocks: string[];
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
  /**
   * Number of inter-procedural FUNCTION hops the U1 forward closure descended
   * (0 ⇒ intra-only, e.g. a pre-namespace-v4 index or a leaf statement). When >0
   * the slice crossed function boundaries, so the note documents the 4 soundness
   * caveats of the context-insensitive descent.
   */
  interproceduralHops?: number;
  /**
   * FU-C: whether the index carries CALL_SUMMARY (return-value ascent). When
   * `false` AND the slice crossed ≥1 inter-procedural hop, the note flags that a
   * PRE-FU-C (v3) index served only the intra slice with no return-value ascent
   * and steers to a re-index. `true` ⇒ ascent active (no extra note).
   */
  callSummaryAvailable?: boolean;
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
  const interproceduralHops = input.interproceduralHops ?? 0;
  if (interproceduralHops > 0) {
    noteParts.push(
      `The statement slice (affectedStatements) crosses ${interproceduralHops} ` +
        `inter-procedural ${interproceduralHops === 1 ? 'hop' : 'hops'} via resolved call ` +
        `sites (HRB context-insensitive forward closure, downstream). SOUNDNESS CAVEATS: ` +
        `(1) context-insensitive — a dependence may be attributed to a callee only reachable ` +
        `from a DIFFERENT call site of the same function (bounded over-inclusion, the same ` +
        `imprecision callgraph mode has); (2) return-value ascent IS captured (via ` +
        `CALL_SUMMARY): a caller statement that depends on a callee's RETURN value is in the ` +
        `slice when the callee has a persisted return-flow summary. Out-parameter / mutated-` +
        `argument ascent, callee-written shared / captured variables, and exception ascent (a ` +
        `throw the caller catches) remain deferred (they need an alias / try-catch model). A ` +
        `PRE-FU-C (v3) --pdg index has no CALL_SUMMARY edges, so return-value ascent is absent ` +
        `there until a re-index; (3) no cross-boundary alias ` +
        `model; (4) precision is bounded by the call RESOLVER's precision (multi-candidate ` +
        `dispatch / C++ overload under-resolution flow through faithfully — sound, never drops a ` +
        `real target).`,
    );
    // FU-C degradation: the slice crossed a call boundary but this index predates
    // CALL_SUMMARY (a v3 `--pdg` index). The intra slice is served, but no
    // return-value ascent ran — steer to a re-index.
    if (input.callSummaryAvailable === false) {
      noteParts.push(
        `no return-value ascent (re-index for CALL_SUMMARY): this --pdg index predates the ` +
          `FU-C return-value-ascent layer, so a caller statement depending on a callee's ` +
          `RETURN value is NOT in the slice. Re-run gitnexus analyze --pdg to record ` +
          `CALL_SUMMARY edges and enable it.`,
      );
    } else if (input.callSummaryAvailable === true) {
      // The CALL_SUMMARY layer is present, but return-value ascent is populated
      // ONLY for TypeScript/JavaScript today (the formal-index it needs is set
      // solely by the TS/JS harvester). For a criterion in any other language the
      // ascent is structurally empty, so say so rather than letting the omission
      // read as "ascent ran and found nothing". Sound — never claims ascent fired.
      // Language is derived HERE in mcp/local, which may name languages; the
      // shared core/ingestion pipeline must not.
      const lang = getProviderForFile(target.filePath)?.id;
      const ascentLanguage =
        lang === SupportedLanguages.TypeScript || lang === SupportedLanguages.JavaScript;
      if (!ascentLanguage) {
        noteParts.push(
          `return-value ascent is currently TypeScript/JavaScript-only (only the TS/JS harvester ` +
            `records the formal-index it needs), so a caller statement depending on a non-TS/JS ` +
            `callee's RETURN value is not in the slice. Descent and the intra slice are unaffected.`,
        );
      }
    }
  }
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
    pdgResultVersion: PDG_RESULT_VERSION,
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
    intraReachableBlocks: input.intraReachableBlocks,
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
  /**
   * FU-C return-value-ascent layer presence (read from `meta.pdg.hasCallSummary`).
   * `true` ⇒ CALL_SUMMARY edges exist, so return-value ascent is active. `false`
   * ⇒ a PRE-FU-C (v3) `--pdg` index — the intra slice is unaffected, but the
   * result should NOTE "no return-value ascent (re-index for CALL_SUMMARY)".
   * Meaningful only for the meta-readable states (`'ready'` / `'sub-layer-missing'`
   * / `'no-layer'`); `undefined` for `'unknown'` (meta unreadable). Deliberately
   * NOT part of the `'ready'` gate — a v3 index is still `'ready'` for the slice.
   */
  hasCallSummary?: boolean;
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
  /**
   * `pdg.hasCallSummary === true` (only meaningful when metaReadable). The FU-C
   * return-value-ascent layer is OPTIONAL — its absence does NOT degrade
   * `pdgLayerStatus` below `'ready'` (a v3 index still serves the intra slice);
   * it only suppresses (and flags) the ascent. Read here so the impact note can
   * steer a pre-FU-C index to re-index without a separate meta probe.
   */
  callSummary: boolean;
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
    if (!meta) return { metaReadable: false, cdg: false, rd: false, callSummary: false };
    return {
      metaReadable: true,
      cdg: meta.pdg?.maxCdgEdgesPerFunction !== undefined,
      rd: meta.pdg?.maxReachingDefEdgesPerFunction !== undefined,
      callSummary: meta.pdg?.hasCallSummary === true,
    };
  } catch {
    // Meta unreadable — the caller decides from the DB (the `'unknown'` state).
    return { metaReadable: false, cdg: false, rd: false, callSummary: false };
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
    // `hasCallSummary` rides on every meta-readable state (it is NOT part of the
    // `'ready'` gate — a v3 index without it is still ready for the intra slice).
    if (caps.cdg && caps.rd) return { state: 'ready', hasCallSummary: caps.callSummary };
    if (caps.cdg !== caps.rd) {
      // Exactly one sub-layer stamped (XOR) — partial layer; impact needs both.
      const missingSubLayer: PdgSubLayer = caps.cdg ? 'REACHING_DEF' : 'CDG';
      return {
        state: 'sub-layer-missing',
        missingSubLayer,
        hasCallSummary: caps.callSummary,
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
      hasCallSummary: caps.callSummary,
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

/**
 * One bounded, direction-aware BFS over CDG + REACHING_DEF starting from a set
 * of seed blocks. Extracted (U1) from `runImpactPDG`'s intra loop so the
 * inter-procedural descent reuses the EXACT same edge query and step/limit
 * semantics — no reimplementation. The query, the one-past-`stepLimit` probe,
 * the per-step truncation flag, and the depth-exhaustion flag are byte-identical
 * to the original inline loop.
 *
 * `visited` is the caller's shared cycle/recursion guard: seeds are pre-added so
 * they are never re-collected (the seed-minus-reachable convention), and any
 * block already visited (a prior callee's seed, or already-reached) is skipped.
 * Newly-discovered blocks are added to `visited` AND returned in `reachable`.
 */
async function bfsReachableBlocks(input: {
  lbugPath: string;
  exec: typeof executeParameterized;
  seedBlocks: string[];
  visited: Set<string>;
  direction: 'upstream' | 'downstream';
  depthBudget: number;
  stepLimit: number;
  probeLimit: number;
}): Promise<{
  reachable: Set<string>;
  depthReached: number;
  truncatedByDepth: boolean;
  truncatedByLimit: boolean;
}> {
  const { lbugPath, exec, seedBlocks, visited, direction, depthBudget, stepLimit, probeLimit } =
    input;
  const reachable = new Set<string>();
  // Seeds are pre-added to `visited` so they are never re-COLLECTED (the
  // seed-minus-reachable convention), but the seed list still drives the first
  // step's frontier — the guard blocks re-collection, not seed re-expansion.
  for (const id of seedBlocks) visited.add(id);
  let frontier = [...seedBlocks];
  let depthReached = 0;
  let truncatedByDepth = false;
  let truncatedByLimit = false;

  const matchEndpoint = direction === 'downstream' ? 'a' : 'b';
  const collectEndpoint = direction === 'downstream' ? 'b' : 'a';

  for (let depth = 0; depth < depthBudget; depth++) {
    if (frontier.length === 0) break;
    const rawRows = await exec(
      lbugPath,
      `MATCH (a:BasicBlock)-[r:CodeRelation]->(b:BasicBlock)
         WHERE r.type IN ['CDG', 'REACHING_DEF'] AND ${matchEndpoint}.id IN $frontier
         RETURN DISTINCT ${collectEndpoint}.id AS id
         LIMIT ${probeLimit}`,
      { frontier },
    );
    // Narrow the awaited rows ONCE at the boundary (executeParameterized returns
    // any[]) to a typed record shape, then read the aliased `id` via bracket
    // access — no `as any` sprayed per field.
    const rows = rawRows.slice(0, stepLimit) as Array<Record<string, unknown>>;
    depthReached = depth + 1;
    if (rawRows.length > stepLimit) truncatedByLimit = true;

    const next: string[] = [];
    for (const r of rows) {
      const id = String(r['id'] ?? '');
      if (!id || visited.has(id)) continue;
      visited.add(id);
      reachable.add(id);
      next.push(id);
    }
    frontier = next;
  }
  if (frontier.length > 0) truncatedByDepth = true;

  return { reachable, depthReached, truncatedByDepth, truncatedByLimit };
}

/** A resolved callee symbol span — the seed window for an inter-procedural hop. */
interface CalleeSpan {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

/**
 * Gather the resolved callee symbol ids invoked across a set of slice blocks
 * (`BasicBlock.calleeIds`). Reuses the SHARED `splitCalleeIds` so the descent
 * cannot diverge from `LocalBackend.calleeIdsOfBlocks` on the split/drop-sentinel
 * logic. A pre-namespace-v4 index (no `calleeIds` column → empty cells) yields no
 * ids, so the descent degrades cleanly to intra-only (no inter-procedural hop).
 */
async function calleeIdsFromBlocks(
  lbugPath: string,
  blockIds: string[],
  exec: typeof executeParameterized,
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const { calleeIds } of await calleeIdsByBlock(lbugPath, blockIds, exec)) {
    for (const id of calleeIds) ids.add(id);
  }
  return ids;
}

/** One slice block paired with the resolved callee ids it invokes. */
interface BlockCallees {
  blockId: string;
  calleeIds: string[];
}

/**
 * Per-block variant of {@link calleeIdsFromBlocks}: keep the CALL block → its
 * `calleeIds` mapping rather than flattening it. The return-value ascent (U-C4)
 * needs this association — it re-seeds the caller's intra closure FROM the
 * specific call block whose callee's `CALL_SUMMARY` licenses the ascent, so the
 * flattened id-only set is insufficient. Reuses the SHARED `splitCalleeIds` so
 * the split/drop-sentinel logic cannot diverge from the flattening caller. A
 * block with no callee ids (empty/whitespace cell, or a pre-v4 index with no
 * `calleeIds` column) yields an empty `calleeIds` — skipped by the consumer.
 */
async function calleeIdsByBlock(
  lbugPath: string,
  blockIds: string[],
  exec: typeof executeParameterized,
): Promise<BlockCallees[]> {
  if (blockIds.length === 0) return [];
  const rows = await exec(
    lbugPath,
    `MATCH (b:BasicBlock) WHERE b.id IN $ids RETURN b.id AS id, b.calleeIds AS calleeIds`,
    { ids: blockIds },
  );
  const out: BlockCallees[] = [];
  // Narrow the awaited rows ONCE at the boundary to a typed record shape; read
  // the aliased cells via bracket access — no per-field `as any`.
  for (const r of rows as Array<Record<string, unknown>>) {
    const blockId = String(r['id'] ?? '');
    if (!blockId) continue;
    const calleeIds = splitCalleeIds(r['calleeIds']);
    if (calleeIds.length > 0) out.push({ blockId, calleeIds });
  }
  return out;
}

/**
 * Of a set of resolved callee symbol ids, which ones have a persisted
 * `CALL_SUMMARY` self-loop edge recording a NON-EMPTY return-value ascent
 * (≥1 formal parameter flows to the callee's return). This is the FU-C consumer
 * side of the producer's per-callee summary (see `call-summary-codec.ts`).
 *
 * The summary is a self-loop on the Function/Method/Constructor node:
 * `(c)-[r:CodeRelation {type:'CALL_SUMMARY'}]->(c) WHERE c.id IN $ids`. The
 * `reason` carries the param→return bitset; `decodeCallSummary` unpacks it and
 * NEVER throws — a malformed / absent / empty (`r:0`) summary yields NO entry
 * (the sound default: never claim a false return-flow). A PRE-FU-C (v3) `--pdg`
 * index has NO `CALL_SUMMARY` edges, so this returns the empty set and the
 * ascent is a clean no-op (the intra slice is unchanged — the documented
 * "re-index for CALL_SUMMARY" degradation).
 */
async function calleesWithReturnFlow(
  lbugPath: string,
  calleeIds: string[],
  exec: typeof executeParameterized,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (calleeIds.length === 0) return out;
  const rows = await exec(
    lbugPath,
    `MATCH (c)-[r:CodeRelation]->(c)
       WHERE r.type = 'CALL_SUMMARY' AND c.id IN $ids
       RETURN c.id AS id, r.reason AS reason`,
    { ids: calleeIds },
  );
  for (const r of rows as Array<Record<string, unknown>>) {
    const id = String(r['id'] ?? '');
    if (!id) continue;
    const decoded = decodeCallSummary(r['reason']);
    // ARG→FORMAL trace precision: the conservative-but-sound default — ascend if
    // ANY formal is return-flowing (the call site's argument is, by construction
    // of the descent, in the slice: the call block is itself a slice block). A
    // specific positional arg↔formal mapping is not cleanly recoverable at the
    // coalesced call block (`BasicBlock.calleeIds` is an unordered set, not a
    // per-arg list), so this never drops a real ascent; it may over-include
    // (bounded — the result still flows to a slice statement). See the descent
    // doc-comment + the result `note` caveat.
    if (decoded.ok && decoded.returnFlowParams.length > 0) out.add(id);
  }
  return out;
}

/**
 * Batch-resolve resolved callee symbol ids → their `{id,filePath,startLine,endLine}`
 * spans via ONE `s.id IN $ids` UNION-ALL query over Function/Method/Constructor —
 * the SAME query shape as `projectBlocksToSymbols`, but keyed on the RESOLVED
 * `s.id` (no same-line ambiguity, unlike the reverse block-to-symbol join). Ids
 * with no matching symbol (a callee resolved to a node kind without a CFG body,
 * or an out-of-repo id) simply produce no span and are skipped — never an error.
 */
async function resolveCalleeSpans(
  lbugPath: string,
  calleeIds: string[],
  exec: typeof executeParameterized,
): Promise<CalleeSpan[]> {
  if (calleeIds.length === 0) return [];
  const rows = await exec(
    lbugPath,
    `MATCH (s:\`Function\`) WHERE s.id IN $ids
       RETURN s.id AS id, s.filePath AS filePath, s.startLine AS startLine, s.endLine AS endLine
     UNION ALL
     MATCH (s:\`Method\`) WHERE s.id IN $ids
       RETURN s.id AS id, s.filePath AS filePath, s.startLine AS startLine, s.endLine AS endLine
     UNION ALL
     MATCH (s:\`Constructor\`) WHERE s.id IN $ids
       RETURN s.id AS id, s.filePath AS filePath, s.startLine AS startLine, s.endLine AS endLine`,
    { ids: calleeIds },
  );
  const spans: CalleeSpan[] = [];
  // Narrow the awaited rows ONCE at the boundary to a typed record shape; read
  // the aliased columns via bracket access with Number()/String() coercion —
  // no per-field `as any` (the same boundary-narrowing the typed helpers use).
  for (const r of rows as Array<Record<string, unknown>>) {
    const id = String(r['id'] ?? '');
    const filePath = String(r['filePath'] ?? '');
    const startLine = Number(r['startLine']);
    const endLine = Number(r['endLine']);
    if (!id || !filePath || !Number.isFinite(startLine) || !Number.isFinite(endLine)) continue;
    spans.push({ id, filePath, startLine, endLine });
  }
  return spans;
}

/**
 * Bounded inter-procedural forward closure (U1) — HRB context-INSENSITIVE
 * forward slicing, the shipped Joern approach. Starting from the intra-procedural
 * slice blocks, descend DOWNSTREAM through resolved call sites: per hop, gather
 * the slice blocks' `calleeIds`, resolve them to callee spans, seed each callee's
 * blocks, run the SAME CDG+REACHING_DEF BFS within the callee, and union the
 * newly-reachable blocks into the slice. Recurses to `depthBudget` FUNCTION hops.
 *
 * Termination is guaranteed by the shared `visited` set (a block is expanded at
 * most once across all hops) plus the depth cap. A total node cap (`nodeBudget`)
 * is the secondary guard against a pathological fan-out within the budget.
 *
 * Caveats (documented in the result note + bench/impact-pdg/README.md):
 *  (1) context-insensitive — a dependence may be attributed to a callee only
 *      reachable from a DIFFERENT call site of the same function (bounded
 *      over-inclusion, the same imprecision callgraph mode already has);
 *  (2) return-value ascent IS captured (via CALL_SUMMARY, U-C4): a caller
 *      statement that depends on a callee's RETURN value is re-seeded into the
 *      caller's continuation when the callee carries a persisted return-flow
 *      summary. Out-parameter / mutated-argument ascent, callee-written shared /
 *      captured variables, and exception ascent (a throw the caller catches)
 *      remain deferred (they need an alias / try-catch model). A pre-FU-C (v3)
 *      --pdg index has no CALL_SUMMARY edges → no return-value ascent there;
 *  (3) no cross-boundary alias model;
 *  (4) precision is bounded by the call RESOLVER's precision (multi-candidate
 *      dispatch / C++ overload under-resolution flow through faithfully — sound,
 *      never drops a real target).
 */
async function interproceduralDescent(input: {
  lbugPath: string;
  exec: typeof executeParameterized;
  /** The intra-procedural slice = seed blocks ∪ intra-reachable blocks. */
  initialSliceBlocks: string[];
  /** Shared cycle/recursion guard (already contains the intra seeds + reach). */
  visited: Set<string>;
  /** FUNCTION-hop budget — how many call boundaries the closure descends. */
  depthBudget: number;
  /**
   * Per-callee intra BFS DEPTH budget (dependence-levels within one callee). The
   * SAME `Math.min(maxDepth, IMPACT_MAX_DEPTH)` clamp the top-level intra BFS
   * applies — NOT `stepLimit` (a row/probe budget): a callee must not be
   * traversable up to `PDG_QUERY_MAX_LIMIT` dependence-levels deep, one
   * sequential DB query per level.
   */
  intraDepthBudget: number;
  stepLimit: number;
  probeLimit: number;
  /** Total newly-reached-block cap across all hops (secondary guard). */
  nodeBudget: number;
  /**
   * Callee symbol ids to treat as ALREADY seeded before the first hop — chiefly
   * the statement seed's OWNER FUNCTION, so direct/mutual recursion back to it
   * never re-seeds the whole-function span the statement slice deliberately
   * excluded (the statement-precision pin would otherwise be re-broadened).
   */
  preSeededCalleeIds?: Iterable<string>;
}): Promise<{
  reachable: Set<string>;
  hopsReached: number;
  truncatedByDepth: boolean;
  truncatedByLimit: boolean;
  truncatedByNodeCap: boolean;
  /**
   * CALL blocks whose callee's `CALL_SUMMARY` licensed a RETURN-VALUE ascent
   * (U-C4): the call's RESULT depends on the slice (the call block is a slice
   * block), so the caller's intra closure continues THROUGH the result. The
   * caller surfaces these blocks' interior source lines (a coalesced call block
   * spans the call statements whose results chain through it) — the
   * statement-granularity realisation of the ascent. The downstream re-seed from
   * the block is already unioned into `reachable`; this set additionally records
   * WHICH blocks got the ascent so the statement projection can expand them.
   */
  ascentBlocks: Set<string>;
}> {
  const {
    lbugPath,
    exec,
    visited,
    depthBudget,
    intraDepthBudget,
    stepLimit,
    probeLimit,
    nodeBudget,
  } = input;
  const reachable = new Set<string>();
  let truncatedByDepth = false;
  let truncatedByLimit = false;
  let truncatedByNodeCap = false;
  let hopsReached = 0;
  // The slice the next hop gathers callees FROM — starts as the intra slice, then
  // becomes each hop's newly-reached callee blocks.
  let sliceBlocks = [...input.initialSliceBlocks];
  // Guard against re-seeding the same callee function across hops. Pre-seeded
  // with the statement seed's owner function so recursion never re-broadens it.
  const seededCalleeIds = new Set<string>(input.preSeededCalleeIds ?? []);
  // U-C4 return-value ascent: CALL blocks whose callee has a non-empty
  // CALL_SUMMARY return-flow → the call's result depends on the slice.
  const ascentBlocks = new Set<string>();

  hopLoop: for (let hop = 0; hop < depthBudget; hop++) {
    if (sliceBlocks.length === 0) break;
    // Keep the CALL block → callee association (U-C4 needs it to re-seed the
    // caller's intra closure FROM the specific call block the ascent licenses);
    // the flattened id set still drives the descent's fresh-callee bookkeeping.
    const blockCallees = await calleeIdsByBlock(lbugPath, sliceBlocks, exec);
    const calleeIds = new Set<string>();
    for (const { calleeIds: ids } of blockCallees) for (const id of ids) calleeIds.add(id);

    // ── U-C4 ascent: re-seed the caller's intra closure THROUGH call results ──
    // For each call block in THIS hop's slice, if ANY of its callees' return
    // values flow back (a non-empty CALL_SUMMARY), the call result is
    // slice-dependent (the call block is itself a slice block). Re-seed a
    // BOUNDED downstream BFS FROM the call block so the caller's continuation
    // that consumes the result is captured. Monotone: only ADDS to `reachable`,
    // reusing the shared `visited` set, so it stays bounded + terminating. A
    // pre-v4 index (no CALL_SUMMARY) yields no return-flowing callees → no-op.
    const returnFlowing = await calleesWithReturnFlow(lbugPath, [...calleeIds], exec);
    if (returnFlowing.size > 0) {
      for (const { blockId, calleeIds: ids } of blockCallees) {
        // Bound the ascent re-seeds the same way the descent bounds its per-span
        // BFS (line ~1496): a wide fan-out of return-flowing call blocks must not
        // run unbounded re-seeds inside a single hop. Mirror the descent's
        // node-cap short-circuit at the TOP of the loop, stamping the same flag.
        if (reachable.size > nodeBudget) {
          truncatedByNodeCap = true;
          break hopLoop;
        }
        if (!ids.some((id) => returnFlowing.has(id))) continue;
        // The call block is in the slice by construction; record it so the
        // statement projection surfaces the call statements whose results chain
        // through it (a coalesced call block spans several call lines).
        ascentBlocks.add(blockId);
        // Continue the caller's intra closure from the call block. The block is
        // already in `visited` (it is a slice block), so the shared-visited BFS
        // only adds genuinely-new downstream caller blocks (e.g. a SEPARATE
        // statement that uses the call result), never re-expanding the seed.
        const ascent = await bfsReachableBlocks({
          lbugPath,
          exec,
          seedBlocks: [blockId],
          visited,
          direction: 'downstream',
          depthBudget: intraDepthBudget,
          stepLimit,
          probeLimit,
        });
        if (ascent.truncatedByLimit) truncatedByLimit = true;
        for (const id of ascent.reachable) reachable.add(id);
      }
    }

    const freshIds = [...calleeIds].filter((id) => !seededCalleeIds.has(id));
    if (freshIds.length === 0) break;
    for (const id of freshIds) seededCalleeIds.add(id);

    const spans = await resolveCalleeSpans(lbugPath, freshIds, exec);
    if (spans.length === 0) break;
    hopsReached = hop + 1;

    // U13: fetch every callee's seed blocks CONCURRENTLY. The seed fetch was the
    // only per-span round-trip; running them in one wave collapses N sequential
    // round-trips. Each span runs the IDENTICAL query as before — same anchor,
    // same LIMIT, same slice — so the per-span seed set and the `exceeded`
    // (truncatedByLimit) flag are byte-identical; only the latency changes. The
    // flag is still APPLIED per span in the sequential loop below, so a span past
    // the node-budget short-circuit never sets it (prior semantics preserved).
    const spanSeeds = await Promise.all(
      spans.map(async (span) => {
        const { anchorClause, queryParams } = blockAnchorForResolvedSymbol(span);
        const rawSeedRows = await exec(
          lbugPath,
          `MATCH (a:BasicBlock) WHERE ${anchorClause} RETURN a.id AS id LIMIT ${probeLimit}`,
          queryParams,
        );
        const exceeded = rawSeedRows.length > stepLimit;
        const seeds = rawSeedRows
          .slice(0, stepLimit)
          .map((r: Record<string, unknown>) => String(r['id'] ?? ''))
          .filter((id: string) => id.length > 0);
        return { exceeded, seeds };
      }),
    );

    // U14: run each callee's BFS CONCURRENTLY against a PRIVATE clone of the
    // hop-start `visited` snapshot, then merge IN SPAN ORDER below. Cross-span
    // sharing of the mutable `visited` set was the ONLY thing forcing the BFS
    // sequential; the clones remove the race. The reachable set is the monotone
    // union of the per-callee closures (order-independent — `bfsReachableBlocks`
    // keys its query on the frontier, not `visited`; `visited` only gates
    // re-collection), so only the per-callee BFS DB round-trips run in parallel
    // while the merged result stays byte-identical. In a degraded case where a
    // per-callee BFS hits its depth/step limit, a sibling may expand through the
    // truncated region — a bounded, sound OVER-approximation, never fewer blocks.
    const visitedSnapshot = new Set(visited);
    const spanBfs = await Promise.all(
      spanSeeds.map(async ({ seeds }) =>
        seeds.length === 0
          ? null
          : bfsReachableBlocks({
              lbugPath,
              exec,
              seedBlocks: seeds,
              visited: new Set(visitedSnapshot), // private clone — no cross-span race
              direction: 'downstream',
              // Per-callee intra DEPTH clamp (block-hops within the callee), NOT
              // the row budget — mirrors the top-level intra BFS depth clamp.
              depthBudget: intraDepthBudget,
              stepLimit,
              probeLimit,
            }),
      ),
    );

    const hopReached = new Set<string>();
    for (let si = 0; si < spans.length; si++) {
      // Node budget is checked INSIDE the per-span MERGE (in span order) so the
      // mid-hop short-circuit stays byte-identical: the cumulative reachable size
      // after merging spans 0..k equals the sequential path's, so the break fires
      // at the SAME span. A span past the break is never merged (its parallel BFS
      // result is discarded), exactly as the sequential loop never processed it.
      if (reachable.size > nodeBudget) {
        truncatedByNodeCap = true;
        break hopLoop;
      }
      const { exceeded, seeds: calleeSeeds } = spanSeeds[si];
      if (exceeded) truncatedByLimit = true;
      if (calleeSeeds.length === 0) continue;
      // A callee seed block IS reachable (the callee is invoked from the slice),
      // unlike the top-level seed which is the target itself.
      for (const id of calleeSeeds) {
        if (!visited.has(id)) {
          visited.add(id);
          reachable.add(id);
          hopReached.add(id);
        }
      }
      const bfs = spanBfs[si];
      if (bfs === null) continue;
      if (bfs.truncatedByLimit) truncatedByLimit = true;
      // The per-callee BFS ran against a clone, so fold its discovered blocks
      // into the shared `visited`/`reachable` here (the sequential path did this
      // inside the BFS); Sets dedup, so order across siblings is irrelevant.
      for (const id of bfs.reachable) {
        visited.add(id);
        reachable.add(id);
        hopReached.add(id);
      }
    }

    if (reachable.size > nodeBudget) {
      truncatedByNodeCap = true;
      break;
    }
    sliceBlocks = [...hopReached];
  }
  // Frontier of callees still expandable after the hop budget ⇒ depth truncation.
  // (Conservative: if the last hop reached blocks AND we used the full budget,
  // deeper callees may exist.)
  if (hopsReached >= depthBudget && sliceBlocks.length > 0) truncatedByDepth = true;

  return {
    reachable,
    hopsReached,
    truncatedByDepth,
    truncatedByLimit,
    truncatedByNodeCap,
    ascentBlocks,
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
  /**
   * Whether this index carries the FU-C `CALL_SUMMARY` return-value-ascent layer
   * (from `meta.pdg.hasCallSummary`, read by the caller's `pdgLayerStatus`).
   * `false`/`undefined` ⇒ a PRE-FU-C (v3) `--pdg` index: the intra slice is
   * served unchanged, but the result `note` flags "no return-value ascent
   * (re-index for CALL_SUMMARY)". Defaults to a sound `false` (no false ascent
   * claim) when the caller omits it.
   */
  callSummaryAvailable?: boolean;
}

export async function runImpactPDG(deps: RunPdgImpactDeps): Promise<PdgImpactResult> {
  const { repo, sym, direction, maxDepth, line, executeParameterized: exec } = deps;
  const callSummaryAvailable = deps.callSummaryAvailable === true;
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
  const seedRows = rawSeedRows.slice(0, stepLimit) as Array<Record<string, unknown>>;
  let seedBlocks: string[] = seedRows
    .map((r) => String(r['id'] ?? ''))
    .filter((id: string) => id.length > 0);
  // Pin the OWNING function for a statement seed: a closure body block that
  // starts on the SAME source line as the seeded statement satisfies the
  // (forgiving) symbol-span window but belongs to a different function, so its
  // intra slice would leak in. The block id encodes the 1-based function start
  // line, and a block of THIS symbol has fnLine === sym.startLine + 1 (block
  // lines 1-based, symbol startLine 0-based). Drop foreign-fn seed blocks —
  // defensively: only when it leaves ≥1 seed, so a kind whose fnLine convention
  // differs never loses a real seed (it keeps the prior, slightly-loose set).
  if (statementMode && typeof sym.startLine === 'number') {
    const ownerFnLine = sym.startLine + 1;
    const owned = seedBlocks.filter((id) => fnLineOf(id) === ownerFnLine);
    if (owned.length > 0) seedBlocks = owned;
  }
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
      pdgResultVersion: PDG_RESULT_VERSION,
      target,
      direction,
      ...(statementMode ? { criterionLine: line } : {}),
      reachableBlocks: [],
      intraReachableBlocks: [],
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
  // BOTH seeds and discovered blocks so a cycle never re-expands. The traversal
  // is the shared `bfsReachableBlocks` — the SAME edge query / step-limit / probe
  // semantics the inter-procedural descent (U1) reuses, so the two cannot diverge.
  const visited = new Set<string>(seedBlocks);
  const intra = await bfsReachableBlocks({
    lbugPath: repo.lbugPath,
    exec,
    seedBlocks,
    visited,
    direction,
    depthBudget,
    stepLimit,
    probeLimit,
  });
  const reachable = intra.reachable;
  // FIX 6: snapshot the INTRA-procedural reachable set BEFORE the U1 descent
  // expands `reachable` with inter-procedurally-reached callee blocks. The
  // callgraph bridge keys its "first-hop proven" set on seed ∪ intra-reachable
  // (the original statement slice) — feeding it the interproc-expanded superset
  // would mark transitively-reached (2+ hop) callgraph targets as first-hop
  // proven, silently shifting the established statementPrecision semantics.
  const intraReachableBlocks = [...reachable].sort();
  const depthReached = intra.depthReached;
  // `truncatedByDepth`: the BFS still had a non-empty frontier when the depth
  // budget ran out (more reachable blocks exist past `maxDepth`).
  // `truncatedByLimit`: a step's neighbour query hit the one-past LIMIT probe.
  // The SEED query is one-past-probed too, so `seedTruncated` seeds the flag — a
  // partial seed is a lower-bound expansion just like a partial step.
  let truncatedByDepth = intra.truncatedByDepth;
  let truncatedByLimit = seedTruncated || intra.truncatedByLimit;

  // ── U1: bounded inter-procedural forward closure (DOWNSTREAM only) ──────────
  // After the intra slice completes and BEFORE block→symbol projection, descend
  // through resolved call sites so the slice crosses function boundaries (HRB
  // context-insensitive forward closure — Joern's shipped approach). Gated to
  // downstream (the dispatcher's direction gate mirrors this): forward closure is
  // only meaningful when following calls forward. A pre-namespace-v4 index (no
  // `calleeIds`) yields no callee ids → the descent is a no-op → byte-identical
  // intra-only behavior. The inter-procedural reach DEEPENS `reachableBlocks`
  // (and thus `affectedStatements`); the owning-symbol `byDepth` stays a single
  // collapsed bucket (block-hops are not call-hops — the standing KTD8 contract;
  // every byDepth consumer iterates generically, so deepening the statement slice
  // — not the bucket count — is the correctness-preserving surface).
  let interproceduralHops = 0;
  // U-C4: CALL blocks whose callee's CALL_SUMMARY licensed a return-value ascent
  // (empty for an upstream slice, a pre-FU-C v3 index, or no return-flowing
  // callee). The statement projection expands these blocks to their interior
  // call lines (a coalesced call block spans several statements whose results
  // chain through it — the statement-granularity realisation of the ascent).
  let ascentBlocks = new Set<string>();
  if (direction === 'downstream') {
    const interproc = await interproceduralDescent({
      lbugPath: repo.lbugPath,
      exec,
      // The slice the first hop gathers callees from = seeds ∪ intra reach. The
      // seed block(s) are included because a callee invoked directly on the
      // changed line is the most-directly-impacted one (seed-minus-reachable
      // excludes seeds from `reachable`, but they still call out to callees).
      initialSliceBlocks: [...seedBlocks, ...reachable],
      visited,
      depthBudget: INTERPROC_DEPTH_BUDGET,
      // FIX 1: the per-callee intra BFS depth is the SAME depth clamp the
      // top-level intra BFS uses — NOT `stepLimit` (a row/probe budget). A callee
      // must not be traversable up to PDG_QUERY_MAX_LIMIT dependence-levels deep.
      intraDepthBudget: depthBudget,
      stepLimit,
      probeLimit,
      nodeBudget: INTERPROC_NODE_BUDGET,
      // FIX 3: pre-seed the descent with the statement seed's OWNER FUNCTION so
      // direct/mutual recursion back to it never re-seeds the whole-function span
      // the statement slice deliberately excluded. The resolved target symbol id
      // (`sym.id`) is exactly that owner — `_impactImpl` already resolved it.
      preSeededCalleeIds: statementMode ? [sym.id] : [],
    });
    interproceduralHops = interproc.hopsReached;
    ascentBlocks = interproc.ascentBlocks;
    for (const id of interproc.reachable) reachable.add(id);
    if (interproc.truncatedByDepth) truncatedByDepth = true;
    if (interproc.truncatedByLimit) truncatedByLimit = true;
    // FIX 7: the node cap is a SIZE/budget limit, semantically 'limit' — NOT
    // 'depth' (which means dependence-level exhaustion). Map it to truncatedByLimit.
    if (interproc.truncatedByNodeCap) truncatedByLimit = true;
    // FIX 5: do NOT fold the inter-procedural FUNCTION-hop count into
    // `depthReached` (which means intra BLOCK-hop depth — a different unit). The
    // function-hop count is plumbed separately via `interproceduralHops`.
  }

  const reachableBlocks = [...reachable].sort();
  const truncated = truncatedByDepth || truncatedByLimit;
  // truncatedBy PRECEDENCE (U3): when BOTH depth and limit truncation fire, the
  // scalar `truncatedBy` reports 'depth' (the depth ternary is tested first), while
  // `truncatedByReasons` lists BOTH ['depth','limit']. Depth wins the scalar slot
  // because dependence-level exhaustion is the stronger "the slice is incomplete"
  // signal; the reasons array preserves that a size/limit cap also fired. This is a
  // standing precedence contract — keep the depth-first ternary and the both-fire
  // reasons array consistent.
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
  // Scope tag (FU-A): the criterion's OWN function is (sym.filePath, fnLine),
  // where fnLine follows the BasicBlock 1-based convention sym.startLine + 1
  // (the same window used to anchor the seed above). A symbol without a numeric
  // startLine has no owning-fn line to match, so `ownerFnLine` is NaN and every
  // statement tags as 'inter' (no false intra claim).
  const criterionFile = sym.filePath;
  const ownerFnLine = typeof sym.startLine === 'number' ? sym.startLine + 1 : Number.NaN;
  // ── FU-B-2 chain-walk blocks: statement-granular interior recovery ─────────
  // The SINGLE principled mechanism that expands a coalesced straight-line
  // BasicBlock to its interior dependent statements via the self REACHING_DEF
  // def→use LINE chain. Two contributors:
  //  - the SEED block(s), seeded at the criterion `line` (statement mode only):
  //    recovers the interior statements of the criterion's own coalesced block
  //    that the block-granular slice lost (the U2 intra-dataflow-chain gap —
  //    line 7's `7-9` block yields {8,9}). The seed block is NOT in
  //    `reachableBlocks` (seeds are excluded), so the walk surfaces lines no
  //    other projection reaches.
  //  - each U-C4 ascent CALL block, seeded from its own start line (empty entry
  //    set ⇒ the projection default-seeds at the block start): the principled
  //    replacement for FU-C's blind all-interior-lines expansion.
  const chainWalkBlocks = new Map<string, ReadonlySet<number>>();
  if (statementMode) {
    for (const id of seedBlocks) chainWalkBlocks.set(id, new Set<number>([line as number]));
  }
  // Every REACHABLE coalesced block is also walked, seeded from its own start
  // line (empty entry set ⇒ the projection default-seeds at the block start): a
  // block reached via CDG (a control-dependent body block) or REACHING_DEF can
  // itself coalesce a straight-line data-dep chain whose interior statements the
  // block-start projection would lose (e.g. the guard fixture's `const y; const
  // z = y + 1;` post-guard body — line 12 chains from line 11 via `y`). This is
  // the SAME principled self-edge walk, applied to the whole slice, not just the
  // seed.
  for (const id of reachableBlocks) {
    if (!chainWalkBlocks.has(id)) chainWalkBlocks.set(id, new Set<number>());
  }
  for (const id of ascentBlocks) {
    if (!chainWalkBlocks.has(id)) chainWalkBlocks.set(id, new Set<number>());
  }
  const affectedStatements = await pdgStatementsForBlocks(
    repo.lbugPath,
    reachableBlocks,
    exec,
    criterionFile,
    ownerFnLine,
    chainWalkBlocks,
  );

  // ── Has a PDG body but no inter-block dependence reachability ──────────────
  // Distinct from "no PDG body": the function exists and has blocks, but no
  // CDG/REACHING_DEF edge leaves the target's blocks in this direction (no
  // DISTINCT downstream BasicBlock is reached). For a WHOLE-SYMBOL seed this is
  // the expected (and uninformative) result — every intra-procedural block is
  // already a seed — so the note steers to `line`. Still not a confident zero —
  // explicit note + UNKNOWN (KTD6/KTD8).
  //
  // Item 5 robustness: `affectedStatements` was ALREADY computed above with the
  // seed block(s) in `chainWalkBlocks`, so a criterion whose only dependents are
  // INTERIOR to its own coalesced seed block (a straight-line chain with no
  // distinct downstream block — e.g. `const a; const b = a*2; const c = b-3`
  // with no `return`) still has those recovered interior statements here. Surface
  // them rather than hardcoding `[]` (which would silently drop the seed-block
  // chain-walk on this path). `reachableBlocks` stays `[]` — those lines belong to
  // the seed block, correctly not a reachable BLOCK — but the statement slice is
  // not lost.
  if (reachableBlocks.length === 0) {
    return {
      mode: 'pdg',
      pdgResultVersion: PDG_RESULT_VERSION,
      target,
      direction,
      ...(statementMode ? { criterionLine: line } : {}),
      impactedCount: 0,
      risk: 'UNKNOWN',
      epistemic: 'pdg-intra-procedural',
      note: statementMode
        ? `No statement in '${sym.name}' is in a DISTINCT ${direction}-dependent block of ` +
          `line ${line} (no CDG/REACHING_DEF edge leaves the seed block in this direction). ` +
          `Any interior statements of the seed's own coalesced block that depend on line ${line} ` +
          `are surfaced in affectedStatements.`
        : `'${sym.name}' has a PDG body but a WHOLE-SYMBOL ${direction} slice is empty: ` +
          `intra-procedural dependence stays inside the function, so every reachable block ` +
          `is already part of the seed. Pass line:<N> to slice from a specific statement ` +
          `(what depends on the code at that line). Inter-procedural symbol reach is attached ` +
          `separately by the unified impact dispatcher.`,
      reachableBlocks: [] as string[],
      // Empty intra reach (reachableBlocks is empty here) — the bridge keys on
      // seed ∪ intra-reachable, so an empty intra slice leaves the bridge to seed
      // from the seed blocks alone (FIX 6 parity field).
      intraReachableBlocks: [] as string[],
      // Carry the real seed blocks (non-empty here — the function HAS blocks, they
      // are all seeds): a callee invoked directly on the seeded line must still be
      // provable even when the line has no downstream dependents (the seed-line FN
      // the tri-review found). Empty reachableBlocks must NOT zero the seed callees.
      seedBlocks,
      blockCount: 0,
      affectedStatements,
      affectedStatementCount: affectedStatements.length,
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
    intraReachableBlocks,
    seedBlocks,
    affectedStatements,
    criterionLine: statementMode ? (line as number) : undefined,
    projection,
    depthReached,
    truncated,
    truncatedBy,
    truncatedByReasons,
    interproceduralHops,
    callSummaryAvailable,
  });
}

// ── PDG inter-procedural bridge evidence + unified result composition ─────────
// Moved from local-backend.ts (#2227 U13): these are pure PDG-result-shaping
// helpers, cohesive with this module's projection/assembly role. LocalBackend
// keeps the DB-access seams (calleesOfBlocks, _runImpactBFS) and imports these.

type PdgBridgeEvidence = Extract<PdgImpactEvidence, 'callgraph-bridge' | 'unproven-bridge'>;

export interface PdgBridgeEvidenceInfo {
  evidence: PdgBridgeEvidence;
  basis: string;
}

export interface PdgBridgeOptions {
  /**
   * Leaf callee names invoked in the criterion's dependence-slice blocks
   * (`BasicBlock.callees`). A first-hop callee is "proven" statement-precise iff
   * its name is in this set — i.e. it is actually called from a statement the
   * changed line reaches, not merely somewhere in the whole function. Empty/absent
   * ⇒ no statement slice to discriminate (upstream or whole-symbol) ⇒ the symbol
   * graph is used as a compatibility bridge (all callgraph-bridge), preserving
   * callgraph reach.
   *
   * REQUIRED (co-populated with {@link sliceCalleeIds}): `local-backend` builds
   * the bridge by reading BOTH cells from the same slice blocks, so a missing
   * key is an EMPTY set, never `undefined`. Keeping both non-optional is what
   * lets the capped-block sentinel guard below read `sliceCalleeNames` directly
   * (the cap is name-agnostic — a capped block always carries the sentinel here).
   */
  sliceCalleeNames: ReadonlySet<string>;
  /**
   * Resolved callee symbol ids invoked in the criterion's dependence-slice blocks
   * (`BasicBlock.calleeIds`). This is the SOUND primary key: a first-hop callee is
   * "proven" statement-precise iff its resolved symbol id is in this set, which
   * eliminates same-leaf-name collision (false-positive) and import-alias/rename
   * (false-negative) — failure modes the name set cannot distinguish. Empty/absent
   * ⇒ no captured ids (pre-v3 index / upstream / whole-symbol) ⇒ fall back to the
   * leaf-name match (`sliceCalleeNames`). REQUIRED (co-populated with
   * {@link sliceCalleeNames}) — an empty set means "no ids", never `undefined`.
   */
  sliceCalleeIds: ReadonlySet<string>;
}

export function pdgBridgeEvidenceForImpact(input: {
  bridge: PdgBridgeOptions;
  depth: number;
  calleeName: unknown;
  calleeId?: unknown;
  inherited?: PdgBridgeEvidenceInfo;
}): PdgBridgeEvidenceInfo {
  const { bridge, depth, calleeName, calleeId, inherited } = input;
  if (depth > 1) {
    return (
      inherited ?? {
        evidence: 'unproven-bridge',
        basis: 'first-hop evidence unavailable for inherited symbol-graph reach',
      }
    );
  }

  const sliceCalleeNames = bridge.sliceCalleeNames;
  // Whole-symbol compatibility bridge ONLY when NEITHER key discriminates. The
  // empty-names guard must also require empty ids: `local-backend` builds the
  // bridge when names OR ids have signal, so an id-only slice (names empty/absent,
  // ids present — e.g. a block whose calls resolve to ids but carry no static leaf
  // name) must fall through to the resolved-id branch, not short-circuit to
  // "prove everything". (PR #2227 tri-review-2 headline.)
  if (sliceCalleeNames.size === 0 && bridge.sliceCalleeIds.size === 0) {
    return {
      evidence: 'callgraph-bridge',
      basis: 'whole-symbol PDG result uses symbol graph as compatibility bridge',
    };
  }

  // A slice block whose call sites were truncated at the per-statement cap has an
  // INCOMPLETE callee list, so absence from the set does not prove absence from
  // the slice. Keep such reach callgraph-equal rather than under-proving. (A capped
  // block always carries the sentinel in `callees`/names — the per-statement cap is
  // name-agnostic — so checking names suffices. `sliceCalleeNames` is always
  // present now (an id-only slice has it as an empty set, never capped), so the
  // direct `.has` is sound.)
  if (sliceCalleeNames.has(CALLEES_TRUNCATED_SENTINEL)) {
    return {
      evidence: 'callgraph-bridge',
      basis: 'a slice block truncated its call sites — callee set is incomplete (callee-unknown)',
    };
  }

  // Sound primary key (KTD3): when the slice carries resolved callee ids and the
  // block is not capped (sentinel handled above), prove by exact symbol-id match.
  // An id that is NOT in the present set is a real proof failure (`unproven-bridge`),
  // NOT a fall-through to the name predicate — the name path would re-leak the
  // same-name collision this key exists to eliminate.
  const sliceCalleeIds = bridge.sliceCalleeIds;
  if (sliceCalleeIds.size > 0) {
    const id = typeof calleeId === 'string' ? calleeId : '';
    if (id && sliceCalleeIds.has(id)) {
      return {
        evidence: 'callgraph-bridge',
        basis:
          'callee id is invoked in a block of the local PDG dependence slice (resolved-symbol match)',
      };
    }
    return {
      evidence: 'unproven-bridge',
      basis: 'callee id is not invoked in any block of the local PDG dependence slice',
    };
  }

  // R3 graceful fallback: no captured ids (pre-v3 index / upstream / whole-symbol)
  // ⇒ use the leaf-name match.
  const name = typeof calleeName === 'string' ? calleeName : '';
  if (name && sliceCalleeNames.has(name)) {
    return {
      evidence: 'callgraph-bridge',
      basis: 'callee is invoked in a block of the local PDG dependence slice',
    };
  }

  return {
    evidence: 'unproven-bridge',
    basis: 'callee is not invoked in any block of the local PDG dependence slice',
  };
}

/**
 * Pick the stronger of two bridge-evidence verdicts for the same reached symbol.
 * `callgraph-bridge` (proven) beats `unproven-bridge`, so a node reachable from
 * multiple parents is proven if ANY parent proves it. This makes the
 * proven/unproven label order-independent of DB row iteration — a diamond-reached
 * symbol gets the same label regardless of which parent the BFS visits first
 * (PR #2227 tri-review, P3).
 */
export function betterBridgeEvidence(
  existing: PdgBridgeEvidenceInfo | undefined,
  candidate: PdgBridgeEvidenceInfo,
): PdgBridgeEvidenceInfo {
  if (!existing) return candidate;
  if (existing.evidence === 'callgraph-bridge') return existing;
  if (candidate.evidence === 'callgraph-bridge') return candidate;
  return existing;
}

function normalizePdgBridgeByDepth(byDepth: Record<number, unknown[]>): Record<number, unknown[]> {
  const normalized: Record<number, unknown[]> = {};
  for (const [depthKey, items] of Object.entries(byDepth ?? {})) {
    const depth = Number(depthKey);
    if (!Number.isFinite(depth) || !Array.isArray(items)) continue;
    normalized[depth] = items.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const record = item as Record<string, unknown>;
      const evidence =
        typeof record.pdgEvidence === 'string'
          ? (record.pdgEvidence as PdgImpactEvidence)
          : 'callgraph-bridge';
      return {
        ...record,
        pdgEvidence: evidence,
        ...(record.pdgEvidenceReason
          ? {}
          : {
              pdgEvidenceReason:
                evidence === 'unproven-bridge'
                  ? 'symbol reached through the resolved symbol graph, but the existing graph did not prove the first-hop call site is in the local PDG slice'
                  : 'symbol reached through the resolved symbol graph compatibility bridge',
            }),
      };
    });
  }
  return normalized;
}

function countPdgEvidence(
  byDepth: Record<number, unknown[]>,
): Partial<Record<PdgImpactEvidence, number>> {
  const counts: Partial<Record<PdgImpactEvidence, number>> = {};
  for (const items of Object.values(byDepth ?? {})) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const evidence = (item as { pdgEvidence?: unknown }).pdgEvidence;
      if (typeof evidence !== 'string') continue;
      counts[evidence as PdgImpactEvidence] = (counts[evidence as PdgImpactEvidence] ?? 0) + 1;
    }
  }
  return counts;
}

function dominantInterproceduralEvidence(
  counts: Partial<Record<PdgImpactEvidence, number>>,
): PdgBridgeEvidence | undefined {
  if ((counts['unproven-bridge'] ?? 0) > 0) return 'unproven-bridge';
  if ((counts['callgraph-bridge'] ?? 0) > 0) return 'callgraph-bridge';
  return undefined;
}

/**
 * Statement-precise projection of the inter-procedural bridge: the subset PROVEN
 * to be invoked from the criterion's dependence slice (`callgraph-bridge`),
 * dropping `unproven-bridge` symbols — reachable in the call graph but only from
 * statements the changed line does not reach. Additive: the full
 * `interproceduralByDepth` is unchanged and still preserves callgraph reach; this
 * answers the tighter "which other functions does changing THIS line affect?".
 * For an upstream / whole-symbol seed there is no discriminating slice, so every
 * symbol is `callgraph-bridge` and the projection equals the full reach
 * (`statementPrecision` = 1). When the slice carries resolved callee ids the
 * projection is SOUND — a reached symbol is proven iff its resolved id matches a
 * slice-block id (resolved-symbol match), so neither a same-named out-of-slice
 * callee nor an aliased import perturbs the set. The leaf-name match is the
 * documented fallback (pre-v3 index / no captured ids), and only in that
 * name-fallback path is the projection a conservative SUPERSET (a callee invoked
 * from both an in-slice and out-of-slice site resolves to proven).
 */
function projectStatementPreciseByDepth(
  byDepth: Record<number, unknown[]>,
): Record<number, unknown[]> {
  const out: Record<number, unknown[]> = {};
  for (const [depthKey, items] of Object.entries(byDepth ?? {})) {
    const depth = Number(depthKey);
    if (!Number.isFinite(depth) || !Array.isArray(items)) continue;
    const proven = items.filter(
      (item) =>
        item &&
        typeof item === 'object' &&
        (item as { pdgEvidence?: unknown }).pdgEvidence !== 'unproven-bridge',
    );
    if (proven.length > 0) out[depth] = proven;
  }
  return out;
}

/**
 * Compose `mode:'pdg'` into one user-facing impact result:
 *
 * - `affectedStatements` / `reachableBlocks` stay owned by the persisted PDG
 *   layer (CDG + REACHING_DEF), preserving the statement-level intra result.
 * - `interproceduralByDepth` / `pdgInterprocedural` expose the symbol reach;
 *   `byDepth` stays as the compatibility symbol bucket so existing consumers
 *   still see one PDG result shape.
 *
 * The callgraph option remains available as the comparator/default path; this
 * helper only changes the `pdg` result contract from intra-only to unified.
 */
export function composeUnifiedPdgImpactResult(
  pdgResult: PdgImpactResult,
  interproceduralResult: any | null,
  interproceduralError?: unknown,
): PdgImpactResult {
  if ('error' in pdgResult || 'pdgLayer' in pdgResult) return pdgResult;

  const localByDepth = pdgResult.byDepth ?? {};
  const localByDepthCounts = pdgResult.byDepthCounts ?? {};
  const interproceduralByDepth = normalizePdgBridgeByDepth(interproceduralResult?.byDepth ?? {});
  const interproceduralByDepthCounts = interproceduralResult?.byDepthCounts ?? {};
  const interproceduralEvidenceCounts = countPdgEvidence(interproceduralByDepth);
  const interproceduralEvidence = dominantInterproceduralEvidence(interproceduralEvidenceCounts);
  // Additive statement-precise projection (see projectStatementPreciseByDepth):
  // the proven subset of the inter-procedural reach. `interproceduralByDepth`
  // above is unchanged and still preserves full callgraph reach.
  const statementPreciseByDepth = projectStatementPreciseByDepth(interproceduralByDepth);
  const statementPreciseByDepthCounts: Record<number, number> = {};
  for (const [depthKey, items] of Object.entries(statementPreciseByDepth)) {
    statementPreciseByDepthCounts[Number(depthKey)] = (items as unknown[]).length;
  }
  const provenBridgeCount = interproceduralEvidenceCounts['callgraph-bridge'] ?? 0;
  const unprovenBridgeCount = interproceduralEvidenceCounts['unproven-bridge'] ?? 0;
  const statementPrecision =
    provenBridgeCount + unprovenBridgeCount > 0
      ? provenBridgeCount / (provenBridgeCount + unprovenBridgeCount)
      : null;
  const byDepth: Record<number, unknown[]> = {};
  const byDepthCounts: Record<number, number> = {};
  const depthKeys = Array.from(
    new Set([
      ...Object.keys(localByDepth),
      ...Object.keys(interproceduralByDepth),
      ...Object.keys(localByDepthCounts),
      ...Object.keys(interproceduralByDepthCounts),
    ]),
  )
    .map((d) => Number(d))
    .filter((d) => Number.isFinite(d))
    .sort((a, b) => a - b);
  // Resolved symbol id of a byDepth item, or null for an unresolved/shadow item.
  const itemId = (item: unknown): string | null => {
    if (item && typeof item === 'object' && 'id' in item) {
      const id = (item as { id?: unknown }).id;
      return typeof id === 'string' && id.length > 0 ? id : null;
    }
    return null;
  };
  // Cross-bucket dedup: a callee can surface in BOTH the local PDG block-expansion
  // AND the inter-procedural callgraph reach, so the raw `local + interproc` sums
  // double-count it. Track each layer's resolved ids to subtract the overlap from
  // the headline (cross-depth) and the per-depth counts.
  const localAllIds = new Set<string>();
  const interAllIds = new Set<string>();
  for (const depth of depthKeys) {
    const localItems = localByDepth[depth] ?? localByDepth[String(depth)] ?? [];
    const interItems = interproceduralByDepth[depth] ?? interproceduralByDepth[String(depth)] ?? [];
    const localDepthIds = new Set<string>();
    for (const it of localItems) {
      const id = itemId(it);
      if (id !== null) {
        localDepthIds.add(id);
        localAllIds.add(id);
      }
    }
    // Drop an interproc item whose resolved id is already present locally AT THIS
    // DEPTH — keep the local item (richer projection). The SAME id reached at a
    // DIFFERENT depth is a legitimate distinct per-depth bucket and is retained
    // (so sum(byDepthCounts) can exceed the cross-depth `impactedCount`).
    let perDepthOverlap = 0;
    const dedupedInter: unknown[] = [];
    for (const it of interItems) {
      const id = itemId(it);
      if (id !== null) interAllIds.add(id);
      if (id !== null && localDepthIds.has(id)) {
        perDepthOverlap += 1;
        continue;
      }
      dedupedInter.push(it);
    }
    const items = [...localItems, ...dedupedInter];
    if (items.length > 0) byDepth[depth] = items;
    const localCount =
      localByDepthCounts[depth] ?? localByDepthCounts[String(depth)] ?? localItems.length;
    const interCount =
      interproceduralByDepthCounts[depth] ??
      interproceduralByDepthCounts[String(depth)] ??
      interItems.length;
    const totalCount = Math.max(0, localCount + interCount - perDepthOverlap);
    if (totalCount > 0) byDepthCounts[depth] = totalCount;
  }
  // Cross-depth overlap of resolved ids reached by BOTH layers. Computed from the
  // visible byDepth ids; if a layer's byDepth was display-truncated this is a
  // lower bound, so the resulting count is a safe over-estimate (never the old
  // double-count, never below the larger single layer).
  let crossOverlap = 0;
  for (const id of interAllIds) if (localAllIds.has(id)) crossOverlap += 1;

  if (Object.keys(byDepthCounts).length === 0) {
    const localZero = localByDepthCounts[1] ?? localByDepthCounts['1'];
    const interZero = interproceduralByDepthCounts[1] ?? interproceduralByDepthCounts['1'];
    if (typeof localZero === 'number' || typeof interZero === 'number') {
      byDepthCounts[1] =
        (typeof localZero === 'number' ? localZero : 0) +
        (typeof interZero === 'number' ? interZero : 0);
    }
  }

  const localImpactedCount =
    typeof pdgResult.impactedCount === 'number' ? pdgResult.impactedCount : 0;
  const interproceduralImpactedCount =
    typeof interproceduralResult?.impactedCount === 'number'
      ? interproceduralResult.impactedCount
      : 0;
  // DISTINCT owning symbols across both layers (was localImpactedCount +
  // interproceduralImpactedCount, which double-counted a symbol reached by both).
  const impactedCount = Math.max(
    0,
    localImpactedCount + interproceduralImpactedCount - crossOverlap,
  );
  // `direct` = distinct depth-1 reach. The deduped byDepthCounts[1] is exactly
  // that union, so it stays consistent with impactedCount (no separate layer sum).
  const directCount = byDepthCounts[1] ?? pdgResult.summary?.direct ?? localImpactedCount;
  const summary = interproceduralResult?.summary
    ? {
        ...interproceduralResult.summary,
        direct: directCount,
      }
    : {
        direct: directCount,
        processes_affected: 0,
        modules_affected: 0,
      };
  const affectedProcesses = interproceduralResult?.affected_processes ?? [];
  const affectedModules = interproceduralResult?.affected_modules ?? [];
  const partial = Boolean(interproceduralResult?.partial || interproceduralError);
  const errorMessage =
    interproceduralError instanceof Error
      ? interproceduralError.message
      : interproceduralError
        ? String(interproceduralError)
        : undefined;

  const noteParts = [
    pdgResult.note,
    `Inter-procedural symbol reach is included using the resolved symbol graph; ` +
      `statement-level PDG reach remains in affectedStatements. The symbol reach is ` +
      `labeled as a PDG evidence bridge, not as pure statement-level dependence.`,
  ];
  if (errorMessage) {
    noteParts.push(
      `Inter-procedural symbol reach failed (${errorMessage}); byDepth is therefore a lower bound.`,
    );
  } else if (interproceduralResult?.epistemic === 'lower-bound') {
    noteParts.push(
      `The inter-procedural symbol reach is a lower bound because unresolved indirection was detected.`,
    );
  }
  if ((interproceduralEvidenceCounts['unproven-bridge'] ?? 0) > 0) {
    noteParts.push(
      `${interproceduralEvidenceCounts['unproven-bridge']} inter-procedural ` +
        `symbol(s) are labeled unproven-bridge: the resolved symbol graph reaches them, ` +
        `but the current graph did not prove their first-hop call site is in the local PDG slice.`,
    );
  }

  return {
    ...pdgResult,
    // Explicit (also carried by the `...pdgResult` spread) so the unified
    // mode:'pdg' exit always advertises the contract version.
    pdgResultVersion: PDG_RESULT_VERSION,
    impactedCount,
    note: noteParts.filter(Boolean).join(' '),
    summary,
    byDepthCounts,
    interproceduralByDepth,
    interproceduralByDepthCounts,
    // Statement-precise (proven) inter-procedural reach is emitted ONLY under
    // `pdgInterprocedural` below — a single source, no top-level duplicate.
    affected_processes: affectedProcesses,
    affected_modules: affectedModules,
    byDepth,
    ...(partial ? { partial: true } : {}),
    ...(interproceduralResult?.epistemic
      ? { interproceduralEpistemic: interproceduralResult.epistemic }
      : {}),
    ...(interproceduralResult?.boundaries
      ? { interproceduralBoundaries: interproceduralResult.boundaries }
      : {}),
    ...(errorMessage ? { interproceduralError: errorMessage } : {}),
    pdgEvidence: {
      // pdgResult is narrowed to the success/empty slice result by the
      // `'error' in / 'pdgLayer' in` guard at the top of this function, so
      // `pdgEvidence` is typed (optional) — no `as any`.
      ...(pdgResult.pdgEvidence ?? {}),
      ...(interproceduralEvidence ? { interprocedural: interproceduralEvidence } : {}),
      interproceduralEvidenceCounts,
    },
    pdgInterprocedural: {
      engine: 'symbol-graph',
      evidence: interproceduralEvidence ?? 'callgraph-bridge',
      impactedCount: interproceduralImpactedCount,
      byDepthCounts: interproceduralByDepthCounts,
      byDepth: interproceduralByDepth,
      evidenceCounts: interproceduralEvidenceCounts,
      statementPreciseByDepth,
      statementPreciseByDepthCounts,
      statementPreciseImpactedCount: provenBridgeCount,
      statementPrecision,
      partial,
    },
  };
}
