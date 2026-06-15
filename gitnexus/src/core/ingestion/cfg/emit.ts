/**
 * cfg/emit.ts (issue #2081, M1) — serialized side-channel → graph.
 *
 * Pure helper: given a file's per-function CFGs (off `ParsedFile.cfgSideChannel`,
 * produced by the worker in U3), emit one persisted `BasicBlock` node per block
 * and one `CFG` edge per edge into the {@link KnowledgeGraph}. Invoked from
 * scope-resolution (run.ts Phase 4) while the disk-backed ParsedFile store is
 * still live — the only window where the worker-built CFGs are loaded (KTD1/
 * KTD5). Default (`--pdg` off) runs never call this, so the emitted graph stays
 * byte-identical to a pre-#2081 run.
 *
 * BasicBlock id: `BasicBlock:<filePath>:<functionStartLine>:<functionStartColumn>:<blockIndex>`
 * (KTD3). The function start line+column segments disambiguate blocks across
 * multiple functions in one file — including same-line functions — since each
 * function's block indices restart at 0; blocks carry no `name` (the
 * BasicBlock table has no such column). The edge KIND
 * (`seq`/`cond-true`/…) rides in the relationship `reason` — CFG edges are
 * values of the single `CodeRelation` table's `type` column (`'CFG'`), so the
 * kind cannot be its own edge type and is queried via `reason`.
 */
import type { KnowledgeGraph } from '../../graph/types.js';
import { generateId } from '../../../lib/utils.js';
import { computeReachingDefs } from './reaching-defs.js';
import { computeControlDependence } from './control-dependence.js';
import {
  computePostDominators,
  isExitReachableFromAllBlocks,
  NO_IPDOM,
} from './post-dominators.js';
import { augmentForPostDom } from './synthetic-escape.js';
import type { BindingEntry, FunctionCfg } from './types.js';

/**
 * Default per-function CFG edge cap. A pathological generated function could
 * otherwise emit an unbounded edge set; the cap bounds graph growth and is
 * overridable via `--pdg` options. `0` (in options) means no cap (unlimited
 * — see the `cap` mapping in {@link emitFileCfgs}); `undefined` means this
 * default.
 */
export const DEFAULT_MAX_CFG_EDGES_PER_FUNCTION = 5000;

/**
 * Default per-function REACHING_DEF edge cap (#2082 M2 KTD9). 4000 mirrors
 * Joern's per-method `maxNumberOfDefinitions` — the closest production prior
 * art — but truncates-and-warns instead of silently skipping the function.
 * Counts (defBlock, useBlock, binding) DEDUPED edges, not statement-level
 * facts. `0` ⇒ unlimited; `undefined` ⇒ this default.
 */
export const DEFAULT_PDG_MAX_REACHING_DEF_EDGES_PER_FUNCTION = 4000;

/**
 * Default per-function CDG edge cap (#2085 M5). CDG edge count is bounded by
 * (blocks × control-nesting-depth) — comparable to the CFG edge count — so it
 * reuses the CFG default of 5000. Counts DEDUPED (controller, dependent, label)
 * edges (the pure {@link computeControlDependence} already dedups). `0` ⇒
 * unlimited; `undefined` ⇒ this default. Folded into the `RepoMeta.pdg` stamp
 * (U5) so introducing CDG forces a full writeback for pre-CDG `--pdg` indexes.
 */
export const DEFAULT_PDG_MAX_CDG_EDGES_PER_FUNCTION = 5000;

/**
 * Heap-safety ceiling on {@link computeControlDependence}'s pre-dedup
 * materialization (#2188 review). The walk is O(edges × post-dom depth), and its
 * `out` IS the deduped-edge quantity the per-function cap trims — so, UNLIKE
 * REACHING_DEF's facts ceiling, this is deliberately NOT derived from the
 * runtime edge cap (doing so would pre-truncate the very set the cap reports on,
 * losing the exact dropped count). A fixed, generous multiple of the default
 * edge cap: far above any real function — a catastrophe backstop only. When hit,
 * the per-function cap reporting plus the `truncated` flag keep it observable
 * (never a silent drop).
 */
export const DEFAULT_PDG_MAX_CDG_MATERIALIZATION_PER_FUNCTION =
  8 * DEFAULT_PDG_MAX_CDG_EDGES_PER_FUNCTION;

/**
 * Env flag that additionally emits diagnostic `POST_DOMINATE` edges
 * (block → its immediate post-dominator) alongside CDG (#2085 M5 KTD8). Off in
 * every normal `--pdg` run — these are for inspecting the post-dom tree, not a
 * queryable product surface. Accepts `1`/`true` (case-insensitive).
 */
export const POST_DOMINATE_DEBUG_ENV = 'GITNEXUS_PDG_EMIT_POST_DOMINATE';

/**
 * Fact-materialization headroom over the edge cap (#2082 M2 U3/F3): facts are
 * O(defs×uses) BY SPEC in merge-heavy code, and the edge cap alone bounds the
 * GRAPH, not the per-function memory spike of materializing facts before
 * dedup. {@link emitFileReachingDefs} hands `edgeCap × this` to
 * `computeReachingDefs` as `maxFacts` (unlimited when the edge cap is 0) —
 * single source of truth; the DEFAULT constant below is derived, never the
 * mechanism.
 */
export const REACHING_DEF_FACTS_PER_EDGE_CAP = 4;

/** Derived emit-path fact limit at the default edge cap (bench/doc anchor). */
export const DEFAULT_PDG_MAX_REACHING_DEF_FACTS_PER_FUNCTION =
  REACHING_DEF_FACTS_PER_EDGE_CAP * DEFAULT_PDG_MAX_REACHING_DEF_EDGES_PER_FUNCTION;

/**
 * Fixpoint-iteration budget for {@link computeReachingDefs}, as a multiple of
 * the function's block count ({@link emitFileReachingDefs} passes
 * `blocks.length × this` as `maxBlockVisits`). Iterative reaching-defs on a
 * reducible CFG converges in O(loop-nesting-depth) passes, so a worklist
 * re-visits each block a small multiple of times for real code; this budget
 * tolerates a nesting depth far beyond any hand-written function (real code is
 * ≤ ~15 deep) while truncating the pathological deep nest that otherwise drives
 * the solver to O(blocks²) — measured at seconds + GB on a machine-generated
 * 2000-line all-loops function whose fact count stays linear (so `maxFacts`
 * never fires). Truncation degrades to a sound empty REACHING_DEF for that one
 * function (status `truncated`), never wrong facts.
 *
 * This ceiling is the SOUND backstop, not a perf fix: WTO / loop-aware iteration
 * ordering was benchmarked and rejected (0% faster — the cost is dense-set
 * propagation, not visitation order; see the no-go note in reaching-defs.ts at
 * the RPO-order site). SSA-sparse reaching-defs is the deferred real fix.
 */
export const DEFAULT_PDG_MAX_REACHING_DEF_BLOCK_REVISITS = 64;

export interface CfgEmitResult {
  blocks: number;
  edges: number;
  /** Edges dropped because a function's edge count exceeded the cap. */
  droppedEdges: number;
  /** Number of functions that hit the cap. */
  cappedFunctions: number;
}

/**
 * The single BasicBlock id template (module doc). Exported for the M3 taint
 * emit path (taint/emit.ts), whose TAINTED/SANITIZES edges must address the
 * SAME persisted block nodes — a re-derived copy of this template would
 * silently dangle the moment either drifted.
 */
export const basicBlockId = (
  filePath: string,
  functionStartLine: number,
  functionStartColumn: number,
  blockIndex: number,
): string => `BasicBlock:${filePath}:${functionStartLine}:${functionStartColumn}:${blockIndex}`;

/**
 * Whether an untrusted `cfgSideChannel` element is safe to feed to
 * {@link emitFileCfgs}. Deliberately NOT full FunctionCfg validation — it
 * checks exactly the fields whose corruption is SILENT given emit's
 * mechanics: {@link basicBlockId} string-templates every id-anchor value
 * (filePath, function start line/column, block index, edge endpoints) and
 * the graph's addNode/addRelationship are no-throw Map inserts. Unchecked,
 * a missing anchor field cross-wires same-`undefined`-id blocks across
 * functions (addNode is first-writer-wins), and an edge endpoint that
 * matches no block index becomes a dangling `BasicBlock:…:<n>` edge that
 * detonates much later at DB bulk-load instead of throwing here — so
 * endpoints are checked for MEMBERSHIP in the block-index set, not just
 * integer-ness. Lives in this module so the guard evolves with the id
 * templating it defends (#2099 F4; M2 fields that join the id path must
 * join this check).
 */
export const isEmitSafeCfg = (cfg: FunctionCfg | undefined | null): cfg is FunctionCfg => {
  if (
    typeof cfg?.filePath !== 'string' ||
    !Number.isInteger(cfg.functionStartLine) ||
    !Number.isInteger(cfg.functionStartColumn) ||
    !Array.isArray(cfg.blocks) ||
    !Array.isArray(cfg.edges)
  ) {
    return false;
  }
  // Contiguity (index === position), not just integer-ness: every consumer —
  // this module's id templating AND the reaching-defs solver's
  // position-indexed adjacency arrays — assumes blocks[i].index === i. A
  // membership-only check would admit a compacted channel ({index:0},{index:5})
  // whose edge 0→5 passes membership but indexes past the arrays downstream.
  for (let i = 0; i < cfg.blocks.length; i++) {
    if (cfg.blocks[i]?.index !== i) return false;
  }
  const n = cfg.blocks.length;
  // entry/exit must land on real blocks — the solver feeds entryIndex straight
  // into its RPO walk, where an out-of-range index throws and (worse than this
  // one element) costs the whole FILE's REACHING_DEF pass (tri-review P3).
  if (
    !Number.isInteger(cfg.entryIndex) ||
    cfg.entryIndex < 0 ||
    cfg.entryIndex >= n ||
    !Number.isInteger(cfg.exitIndex) ||
    cfg.exitIndex < 0 ||
    cfg.exitIndex >= n
  ) {
    return false;
  }
  return cfg.edges.every(
    (e) =>
      Number.isInteger(e?.from) &&
      Number.isInteger(e?.to) &&
      e.from >= 0 &&
      e.from < n &&
      e.to >= 0 &&
      e.to < n,
  );
};

/**
 * Whether a structurally-valid CFG's M2 statement facts are safe to feed to
 * the reaching-defs solver + REACHING_DEF id templating (#2082 U1/U4): the
 * binding table's name/declLine/declColumn template into edge ids, and
 * statement def/use indices must stay IN RANGE of the table (an escaping
 * index would fabricate `undefined`-keyed ids). Deliberately SEPARATE from
 * {@link isEmitSafeCfg}: malformed facts must cost only the function's
 * REACHING_DEF projection — degrading to M1 behavior (CFG emitted, no facts)
 * — never the BasicBlock/CFG layer itself.
 */
export const hasEmitSafeFacts = (cfg: FunctionCfg): boolean => {
  const bindings = cfg.bindings;
  if (bindings === undefined) {
    // Pre-M2 channel — statements must be absent too.
    return cfg.blocks.every((b) => b.statements === undefined);
  }
  if (!Array.isArray(bindings)) return false;
  for (const b of bindings) {
    if (
      typeof b?.name !== 'string' ||
      !Number.isInteger(b.declLine) ||
      !Number.isInteger(b.declColumn)
    ) {
      return false;
    }
  }
  const bindingCount = bindings.length;
  const inRange = (i: number): boolean => Number.isInteger(i) && i >= 0 && i < bindingCount;
  for (const b of cfg.blocks) {
    const stmts = b.statements;
    if (stmts === undefined) continue;
    if (!Array.isArray(stmts)) return false;
    for (const s of stmts) {
      if (!Number.isInteger(s?.line) || !Array.isArray(s.defs) || !Array.isArray(s.uses)) {
        return false;
      }
      if (!s.defs.every(inRange) || !s.uses.every(inRange)) return false;
      if (s.mayDefs !== undefined) {
        if (!Array.isArray(s.mayDefs) || !s.mayDefs.every(inRange)) return false;
      }
    }
  }
  return true;
};

/**
 * Emit BasicBlock nodes + CFG edges for every function CFG in `cfgs`.
 *
 * `maxEdgesPerFunction` caps edges per function. On overflow we stop emitting
 * that function's remaining edges and call `onWarn` naming the dropped count —
 * no silent truncation (KTD6/R6). Block nodes are always fully emitted (their
 * count is bounded by the function's statement count); only edges are capped.
 */
export function emitFileCfgs(
  graph: KnowledgeGraph,
  cfgs: readonly FunctionCfg[],
  maxEdgesPerFunction: number = DEFAULT_MAX_CFG_EDGES_PER_FUNCTION,
  onWarn?: (message: string) => void,
): CfgEmitResult {
  const result: CfgEmitResult = { blocks: 0, edges: 0, droppedEdges: 0, cappedFunctions: 0 };
  const cap = maxEdgesPerFunction > 0 ? maxEdgesPerFunction : Infinity;

  for (const cfg of cfgs) {
    const { filePath, functionStartLine, functionStartColumn } = cfg;

    for (const b of cfg.blocks) {
      graph.addNode({
        id: basicBlockId(filePath, functionStartLine, functionStartColumn, b.index),
        label: 'BasicBlock',
        properties: {
          name: '', // BasicBlock has no name column; identified by id + span
          filePath,
          startLine: b.startLine,
          endLine: b.endLine,
          text: b.text,
        },
      });
      result.blocks++;
    }

    let emittedForFn = 0;
    for (const e of cfg.edges) {
      if (emittedForFn >= cap) {
        const dropped = cfg.edges.length - emittedForFn;
        result.droppedEdges += dropped;
        result.cappedFunctions++;
        onWarn?.(
          `[cfg] ${filePath}:${functionStartLine}: per-function CFG edge cap ` +
            `(${maxEdgesPerFunction}) reached — dropped ${dropped} of ${cfg.edges.length} edges`,
        );
        break;
      }
      const sourceId = basicBlockId(filePath, functionStartLine, functionStartColumn, e.from);
      const targetId = basicBlockId(filePath, functionStartLine, functionStartColumn, e.to);
      graph.addRelationship({
        id: generateId('CFG', `${sourceId}->${targetId}:${e.kind}`),
        type: 'CFG',
        sourceId,
        targetId,
        confidence: 1.0,
        reason: e.kind, // CfgEdgeKind (seq/cond-true/loop-back/…) — queryable
      });
      result.edges++;
      emittedForFn++;
    }
  }

  return result;
}

export interface ReachingDefEmitResult {
  /** Deduped (defBlock, useBlock, binding) edges persisted. */
  edges: number;
  /** Deduped edges dropped by the per-function edge cap. */
  droppedEdges: number;
  cappedFunctions: number;
  /** Functions whose FACT materialization hit the solver's maxFacts limit. */
  truncatedFunctions: number;
  /** Functions whose facts failed {@link hasEmitSafeFacts} (CFG kept, facts skipped). */
  malformedFactFunctions: number;
  /** Total statement-level facts the solver produced (pre-dedup telemetry). */
  facts: number;
}

/**
 * Stable identity for a binding inside edge ids (#2082 M2 KTD3/KTD9):
 * `name:declLine:declCol` for declared bindings, `name@module` for synthetic
 * ones. Distinct same-name bindings never share a key; identifier characters
 * cannot contain the id separators. Exported for the M3 taint emit path —
 * TAINTED/SANITIZES ids key bindings with the same discipline.
 */
export const bindingKey = (b: BindingEntry): string =>
  b.synthetic ? `${b.name}@module` : `${b.name}:${b.declLine}:${b.declColumn}`;

/**
 * Compute reaching definitions per function and persist the bounded
 * REACHING_DEF projection (#2082 M2 U4).
 *
 * Facts are DEDUPED to (defBlock, useBlock, binding) before budgeting — the
 * persisted columns (`from,to,type,confidence,reason,step`; relationship ids
 * are in-memory-only, the CodeRelation table has no id column) cannot
 * distinguish finer rows, so statement-indexed ids would only manufacture
 * byte-identical duplicate rows that burn budget. Statement granularity lives
 * in the in-memory {@link computeReachingDefs} result, which the M3 taint
 * engine recomputes on demand — the budget here governs only this projection
 * and can never drop a taint fact.
 *
 * R7 (no silent truncation) covers BOTH layers: the per-function edge cap AND
 * the solver's fact-materialization limit (which can fire without the edge
 * cap ever being reached, since dedup is many-to-one) each produce one
 * unconditional `onWarn`. The edge-cap warn names the top bindings by fact
 * count — overflow is almost always one variable, which is exactly the datum
 * M3 tuning wants.
 */
export function emitFileReachingDefs(
  graph: KnowledgeGraph,
  cfgs: readonly FunctionCfg[],
  maxEdgesPerFunction: number = DEFAULT_PDG_MAX_REACHING_DEF_EDGES_PER_FUNCTION,
  onWarn?: (message: string) => void,
): ReachingDefEmitResult {
  const result: ReachingDefEmitResult = {
    edges: 0,
    droppedEdges: 0,
    cappedFunctions: 0,
    truncatedFunctions: 0,
    malformedFactFunctions: 0,
    facts: 0,
  };
  const cap = maxEdgesPerFunction > 0 ? maxEdgesPerFunction : Infinity;
  const maxFacts = Number.isFinite(cap) ? (cap as number) * REACHING_DEF_FACTS_PER_EDGE_CAP : 0; // 0 ⇒ unlimited

  for (const cfg of cfgs) {
    // Graceful degradation: malformed M2 facts cost only this function's
    // REACHING_DEF projection — its BasicBlock/CFG layer was already emitted.
    if (!hasEmitSafeFacts(cfg)) {
      result.malformedFactFunctions++;
      onWarn?.(
        `[reaching-defs] ${cfg.filePath}:${cfg.functionStartLine}: malformed ` +
          `statement facts (bad binding table or out-of-range fact indices) — ` +
          `REACHING_DEF skipped for this function; its CFG is unaffected`,
      );
      continue;
    }
    const r = computeReachingDefs(cfg, {
      maxFacts,
      maxBlockVisits: cfg.blocks.length * DEFAULT_PDG_MAX_REACHING_DEF_BLOCK_REVISITS,
    });
    if (r.status === 'no-facts') continue;
    result.facts += r.facts.length;

    const { filePath, functionStartLine, functionStartColumn } = cfg;
    if (r.status === 'truncated') {
      result.truncatedFunctions++;
      onWarn?.(
        `[reaching-defs] ${filePath}:${functionStartLine}: fact materialization ` +
          `limit (${maxFacts}) reached — facts beyond it were not computed; ` +
          `the persisted REACHING_DEF projection for this function is sparse`,
      );
    } else if (r.status === 'overflow') {
      result.truncatedFunctions++;
      onWarn?.(
        `[reaching-defs] ${filePath}:${functionStartLine}: a basic block exceeds ` +
          `the def-key stride (≥2^21 coalesced statements — minified/generated ` +
          `code) — REACHING_DEF skipped for this function (computing any facts ` +
          `would risk wrong-block aliasing); its CFG is unaffected`,
      );
      continue;
    }

    // Dedup to (defBlock, useBlock, binding) — facts arrive sorted, so the
    // deduped order (and therefore cap truncation) is deterministic.
    const seen = new Set<string>();
    const deduped: { defBlock: number; useBlock: number; bindingIdx: number }[] = [];
    for (const f of r.facts) {
      const key = `${f.def.blockIndex}:${f.use.blockIndex}:${f.bindingIdx}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push({
        defBlock: f.def.blockIndex,
        useBlock: f.use.blockIndex,
        bindingIdx: f.bindingIdx,
      });
    }

    let emittedForFn = 0;
    for (const edge of deduped) {
      if (emittedForFn >= cap) {
        const dropped = deduped.length - emittedForFn;
        result.droppedEdges += dropped;
        result.cappedFunctions++;
        // Tallied lazily — cap overflow is the rare path; the common uncapped
        // case must not pay a per-fact counting pass.
        const factsPerBinding = new Map<number, number>();
        for (const f of r.facts) {
          factsPerBinding.set(f.bindingIdx, (factsPerBinding.get(f.bindingIdx) ?? 0) + 1);
        }
        const top = [...factsPerBinding.entries()]
          .sort((a, b) => b[1] - a[1] || a[0] - b[0])
          .slice(0, 2)
          .map(([idx, count]) => `${r.bindings[idx]?.name ?? `#${idx}`}(${count} facts)`)
          .join(', ');
        onWarn?.(
          `[reaching-defs] ${filePath}:${functionStartLine}: per-function ` +
            `REACHING_DEF edge cap (${maxEdgesPerFunction}) reached — dropped ` +
            `${dropped} of ${deduped.length} edges; top bindings: ${top}`,
        );
        break;
      }
      const binding = r.bindings[edge.bindingIdx];
      const sourceId = basicBlockId(
        filePath,
        functionStartLine,
        functionStartColumn,
        edge.defBlock,
      );
      const targetId = basicBlockId(
        filePath,
        functionStartLine,
        functionStartColumn,
        edge.useBlock,
      );
      graph.addRelationship({
        // Single function anchor — the two block ids share it, so templating
        // it once halves the id size (ids are in-memory-only but ~4000 of
        // them per capped function is real transient heap).
        id: generateId(
          'REACHING_DEF',
          `${filePath}:${functionStartLine}:${functionStartColumn}:` +
            `${edge.defBlock}->${edge.useBlock}:${bindingKey(binding)}`,
        ),
        type: 'REACHING_DEF',
        sourceId,
        targetId,
        confidence: 1.0,
        reason: binding.name, // plain source-level name (M0/S1 verdict) — queryable
      });
      result.edges++;
      emittedForFn++;
    }
  }

  return result;
}

export interface CdgEmitResult {
  /** Deduped (controller, dependent, label) CDG edges persisted. */
  edges: number;
  /** CDG edges dropped by the per-function edge cap. */
  droppedEdges: number;
  /** Functions that hit the CDG edge cap. */
  cappedFunctions: number;
  /** Diagnostic POST_DOMINATE edges emitted (0 unless the debug env is set). */
  postDominateEdges: number;
  /**
   * Functions skipped because EXIT was not reachable from every entry-reachable
   * block — post-dominance would be unsound (#2188 review). CFG/REACHING_DEF for
   * those functions are kept; only their CDG projection is omitted.
   */
  skippedUnsoundFunctions: number;
}

/** Whether the POST_DOMINATE debug env flag is enabled (`1`/`true`). */
const postDominateDebugEnabled = (): boolean => {
  const v = process.env[POST_DOMINATE_DEBUG_ENV];
  return v === '1' || v?.toLowerCase() === 'true';
};

/**
 * Compute control dependence per function and persist the bounded CDG
 * projection (#2085 M5 U4). Mirrors {@link emitFileReachingDefs}: the pure
 * {@link computeControlDependence} already dedups to (controller, dependent,
 * label), so the per-function cap applies to deduped edges and overflow logs
 * one unconditional `onWarn` naming the dropped count — no silent truncation
 * (R6/R7). The branch label ('T'|'F') rides the `reason` column (KTD3),
 * mirroring how CFG stores its edge kind.
 *
 * When {@link POST_DOMINATE_DEBUG_ENV} is set, also emits diagnostic
 * `POST_DOMINATE` edges (block → its immediate post-dominator). These are NOT
 * capped or counted against the CDG budget — they exist only for inspecting the
 * post-dom tree and never appear in a normal run.
 */
export function emitFileCdg(
  graph: KnowledgeGraph,
  cfgs: readonly FunctionCfg[],
  maxEdgesPerFunction: number = DEFAULT_PDG_MAX_CDG_EDGES_PER_FUNCTION,
  onWarn?: (message: string) => void,
): CdgEmitResult {
  const result: CdgEmitResult = {
    edges: 0,
    droppedEdges: 0,
    cappedFunctions: 0,
    postDominateEdges: 0,
    skippedUnsoundFunctions: 0,
  };
  const cap = maxEdgesPerFunction > 0 ? maxEdgesPerFunction : Infinity;
  const emitPostDom = postDominateDebugEnabled();

  for (const cfg of cfgs) {
    const { filePath, functionStartLine, functionStartColumn } = cfg;
    // Synthetic-escape pass (#2197 U1): restore EXIT reverse-reachability for a
    // genuine exit-unreachable CYCLE (an unconditional `goto`-cycle / infinite
    // loop) so the post-dom / CDG pass runs instead of being withheld. A no-op
    // (returns `cfg` unchanged) for terminating functions and properly-escaped
    // loops — those stay byte-identical. The synthetic edges are ANALYSIS-ONLY:
    // they live on the returned shallow clone, never on the persisted `cfg`, so
    // CFG / REACHING_DEF and the byte-identical-off golden are unaffected. Both
    // the gate below AND the post-dom / CDG passes must see the augmented view
    // (KTD7 — the Ferrante walk re-reads `cfg.edges`).
    const view = augmentForPostDom(cfg);
    // Sound post-dominance requires EXIT reachable from every entry-reachable
    // block (#2188 review). The synthetic-escape pass recovers genuine cycles;
    // anything STILL unreachable after it is a residual non-cycle anomaly (a
    // dangling/dead-end block, a branch-less trapping spin, or a construction
    // error) — NOT something we bridge (that would mask the bug). Skip CDG for
    // it and surface the skip. CFG and REACHING_DEF (emitted elsewhere,
    // independent of post-dominance) are kept.
    if (!isExitReachableFromAllBlocks(view)) {
      result.skippedUnsoundFunctions++;
      onWarn?.(
        `[cdg] ${filePath}:${functionStartLine}: EXIT not reachable from all ` +
          `blocks — CDG skipped for this function (CFG/REACHING_DEF unaffected)`,
      );
      continue;
    }
    // Compute the post-dom tree once and feed it to the control-dependence
    // pass (avoids recomputing it) and to the optional POST_DOMINATE emit. The
    // CDG edges reference BLOCK INDICES, which are identical in `view` and `cfg`
    // (the augmentation only appends edges), so persisting them keyed off the
    // original block ids is correct.
    const tree = computePostDominators(view);
    // Bound the pre-dedup materialization (heap parity with REACHING_DEF). The
    // fixed ceiling is a catastrophe backstop; the per-function edge cap below
    // remains the reporting authority. A ceiling hit is surfaced, not silent.
    const { edges: cdgEdges, truncated } = computeControlDependence(
      view,
      tree,
      DEFAULT_PDG_MAX_CDG_MATERIALIZATION_PER_FUNCTION,
    );
    if (truncated) {
      onWarn?.(
        `[cdg] ${filePath}:${functionStartLine}: control-dependence materialization ` +
          `ceiling (${DEFAULT_PDG_MAX_CDG_MATERIALIZATION_PER_FUNCTION}) reached — ` +
          `edge counts for this function are a floor`,
      );
    }

    let emittedForFn = 0;
    for (const edge of cdgEdges) {
      if (emittedForFn >= cap) {
        const dropped = cdgEdges.length - emittedForFn;
        result.droppedEdges += dropped;
        result.cappedFunctions++;
        onWarn?.(
          `[cdg] ${filePath}:${functionStartLine}: per-function CDG edge cap ` +
            `(${maxEdgesPerFunction}) reached — dropped ${dropped} of ${cdgEdges.length} edges`,
        );
        break;
      }
      const sourceId = basicBlockId(
        filePath,
        functionStartLine,
        functionStartColumn,
        edge.controllerBlock,
      );
      const targetId = basicBlockId(
        filePath,
        functionStartLine,
        functionStartColumn,
        edge.dependentBlock,
      );
      graph.addRelationship({
        id: generateId(
          'CDG',
          `${filePath}:${functionStartLine}:${functionStartColumn}:` +
            `${edge.controllerBlock}->${edge.dependentBlock}:${edge.label}`,
        ),
        type: 'CDG',
        sourceId,
        targetId,
        confidence: 1.0,
        reason: edge.label, // 'T' | 'F' — queryable, mirrors CFG's kind-in-reason
      });
      result.edges++;
      emittedForFn++;
    }

    if (emitPostDom) {
      for (let b = 0; b < tree.ipdom.length; b++) {
        const ip = tree.ipdom[b];
        if (ip === NO_IPDOM) continue;
        graph.addRelationship({
          id: generateId(
            'POST_DOMINATE',
            `${filePath}:${functionStartLine}:${functionStartColumn}:${b}->${ip}`,
          ),
          type: 'POST_DOMINATE',
          sourceId: basicBlockId(filePath, functionStartLine, functionStartColumn, b),
          targetId: basicBlockId(filePath, functionStartLine, functionStartColumn, ip),
          confidence: 1.0,
          reason: '',
        });
        result.postDominateEdges++;
      }
    }
  }

  return result;
}
