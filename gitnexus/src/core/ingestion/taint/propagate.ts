/**
 * Pure intra-procedural taint propagation engine (#2083 M3 U3).
 *
 * Forward taint reachability over one function's reaching-definition facts
 * (M2 `computeReachingDefs`) and matched taint sites (U2 `matchFunctionSites`)
 * — sources in, findings + sanitizer kills + coverage status out. PURE AND
 * DETERMINISTIC, mirroring the reaching-defs contract: no graph, no I/O, no
 * logger; insertion-ordered worklist; explicitly sorted outputs; snapshot
 * tests and content-derived edge ids (U4) rely on it.
 *
 * PRECONDITIONS: the caller gates the CFG through `hasTaintSafeSites`
 * (taint/site-safety.ts) and the emit-safety checks before calling — this
 * module dereferences binding/site/statement indices without re-validating.
 *
 * ## The two-rule model (plan HTD)
 *
 * - **Rule (b), statement-local:** a matched SOURCE occurrence (member read)
 *   whose intra-statement occurrence path — the member-read's `parent` chain —
 *   reaches a matched SINK argument position produces an immediate single-hop
 *   finding (`exec(req.body)`). The same statement SEEDS taint: every binding
 *   the statement defines becomes tainted (see the precision floor below).
 * - **Rule (a), worklist:** for each tainted `(binding, defPoint)`, every
 *   def→use fact delivers the taint to a use statement, where occurrences of
 *   the binding in matched sink argument positions produce findings and the
 *   statement's own defs are tainted onward. The fact graph contains genuine
 *   cycles (loop back-edges, same-statement self-facts) — the visited-set
 *   discipline below is load-bearing, not defensive.
 *
 * ## Sanitizer semantics — the KIND-SET exclusion model (KTD4, sharpened)
 *
 * The plan sketches a binary kill; this module implements the strictly more
 * precise SOUND refinement: a taint carries a set of *excluded* (neutralized)
 * `SinkKind`s accumulated through sanitizer hops, and a sink fires unless its
 * kind is in the taint's exclusion set. A binary kill is the special case
 * where the sanitizer neutralizes the sink's kind; the kind-set model
 * additionally keeps `const b = escape(req.body); db.query(b)` a FINDING
 * (an HTML escaper does not neutralize SQL — un-tainting `b` outright would
 * be a suppressed live injection, the forbidden false-negative direction)
 * while still suppressing `res.send(b)` (xss IS neutralized).
 *
 * - **Occurrence interposition (KTD4a):** evaluated over the U1 site
 *   structure. An occurrence reaching a sink arg / def-feeding position
 *   through a matched sanitizer site accumulates that sanitizer's
 *   `neutralizes` kinds on that PATH; a direct occurrence contributes the
 *   empty set. Per-position narrowing (`entry.args`) is respected; receiver
 *   flow through a sanitizer is NOT neutralized (the receiver is not the
 *   sanitized payload), and spread/template positions are never neutralized
 *   (position unprovable) — both sound-direction choices (under-kill).
 * - **Intersection over paths:** a def fed by several occurrence paths
 *   excludes a kind only when EVERY path neutralizes it
 *   (`const c = cond ? escape(b) : b` taints `c` with NO exclusions — the
 *   direct arm's ∅ intersects everything away). Equally, a taint re-derived
 *   along a second route keeps the INTERSECTION of the exclusion sets and is
 *   re-processed whenever the set SHRINKS — a less-neutralized taint is
 *   strictly more dangerous. Exclusion sets only shrink over a finite
 *   lattice, so the worklist terminates.
 * - **Kill locality (KTD4b):** a kill applies to the def the sanitizer
 *   produces (`SiteRecord.resultDefs`) only; the flowing binding's own taint
 *   is untouched (`const c = escape(b); exec(b)` still finds `b`'s flow).
 *   `x = escape(x)` works because taint keys on the DEF POINT: the
 *   sanitizer statement's def enters the set with the sanitizer's kinds
 *   excluded, while the seed def keeps flowing wherever the CFG still
 *   carries it (zero-iteration loops, conditional sanitizers — may-path
 *   mechanics need no special handling here, kills are absent from facts).
 *
 * ## Statement-coalescing precision floor (documented FP)
 *
 * Statement facts conflate multi-declarator statements: a statement that
 * uses tainted `b` and defines `c` taints `c` with NO exclusions even when
 * the two are textually unrelated (`const a = clean(z), b = g(t)` floor-
 * taints `a` from `t` — pinned by a test). The per-declarator `resultDefs`
 * precision narrows the EXCLUSION computation (and powers kills) only — a
 * def in a call's `resultDefs` is fed exactly through that call, so its
 * exclusions come from the paths into it; when the tainted input provably
 * never flows into that call, the floor still taints the def (sound) but
 * records no kill (a kill requires evidence of flow through the sanitizer).
 *
 * ## Propagate-through (KTD5)
 *
 * Taint in any argument or in the receiver of an UNMODELED call flows to
 * the call's result defs, marked `viaCall` on the hop so `explain` can
 * express lower confidence. An occurrence that reaches the unmodeled call
 * only through a sanitizer carries the neutralization through
 * (`const y = unknownFn(escape(b))` excludes the sanitizer's kinds — the
 * plan's deliberate precision choice over flat-conservative).
 *
 * ## Kills output
 *
 * `kills` records every sanitizer that ACTUALLY neutralized kinds on a
 * flowing taint — U4 emits `SANITIZES` edges from them. Two shapes share the
 * record: result-def kills (`killedDef` = the def the sanitizer produces;
 * `bindingIdx` = that def's binding) and value-position interposition kills
 * (`exec(escape(x))` — no def exists; `killedDef` = the sink statement's own
 * point, `bindingIdx` = the interposed binding). Interposition kills are
 * recorded only when the (input, sink, position) produced no finding — a
 * bypassed sanitizer (`exec(x + escape(x))`) killed nothing.
 */

import type { FunctionCfg, SiteRecord, StatementFacts } from '../cfg/types.js';
import { pointKey } from '../cfg/reaching-defs.js';
import type { DefUseFact, FunctionDefUse, ProgramPoint } from '../cfg/reaching-defs.js';
import type {
  FunctionSiteMatches,
  MatchedSanitizerCall,
  MatchedSinkCall,
  StatementMatches,
} from './match.js';
import {
  SINK_KIND_ORDER as KIND_ORDER,
  sortSinkKinds as sortKinds,
  type SinkKind,
  type SourceKind,
} from './source-sink-config.js';

/**
 * Default per-function findings cap (U5 config resolution; cfg/emit.ts
 * DEFAULT_* pattern). Resolved into the RepoMeta `pdg` stamp by
 * `resolvePdgConfig` so a cap change trips full writeback; `0` = unlimited
 * is preserved like the other pdg caps. 200 is generous — a real function
 * with more deduped source→sink findings is a fixture or a disaster, and
 * the truncation is deterministic + counted (`droppedFindings`).
 */
export const DEFAULT_PDG_MAX_TAINT_FINDINGS_PER_FUNCTION = 200;

/**
 * Default per-finding hop cap (U5; joins the RepoMeta `pdg` stamp like the
 * findings cap). Bounds the persisted `reason` hop encoding (KTD6 pins the
 * hop cap in config); 32 intra-procedural def→use hops is far beyond any
 * legible path — overflow keeps the source-side prefix and sets
 * `hopsTruncated`, parsed downstream as "path incomplete", never an error.
 */
export const DEFAULT_PDG_MAX_TAINT_HOPS = 32;

export interface TaintLimits {
  /**
   * Maximum findings per function AFTER dedup; the sorted finding list is
   * truncated deterministically and the overflow counted in
   * `droppedFindings`. `undefined`/0 ⇒ unlimited.
   */
  readonly maxFindingsPerFunction?: number;
  /**
   * Maximum hops retained per finding (source-side prefix kept); overflow
   * sets `hopsTruncated`. `undefined`/0 ⇒ unlimited.
   */
  readonly maxHops?: number;
}

/** One hop of a finding's path — enough for U4's reason codec (name, line, flag). */
export interface TaintHop {
  /** Index into the function's binding table. */
  readonly bindingIdx: number;
  /** Resolved binding name (carried so U4 never re-joins the table). */
  readonly name: string;
  readonly point: ProgramPoint;
  /** The value passed through an unmodeled call to get here (KTD5). */
  readonly viaCall?: boolean;
}

/**
 * The source identity material for a finding: either the matched member-read
 * occurrence itself (statement point + site index + object/property) or an
 * assigned call-result source. For worklist findings this is the ROOT source
 * the taint chain was seeded from.
 */
interface BaseSourceOccurrence {
  readonly point: ProgramPoint;
  /** Index into the source statement's `sites` array. */
  readonly siteIndex: number;
  readonly type: 'member-read' | 'call-result';
  readonly kind: SourceKind;
}

interface MemberReadSourceOccurrence extends BaseSourceOccurrence {
  readonly type: 'member-read';
  readonly objectBindingIdx: number;
  readonly property: string;
}

interface CallResultSourceOccurrence extends BaseSourceOccurrence {
  readonly type: 'call-result';
  readonly resultBindingIdx: number;
  readonly calleeName: string;
}

export type TaintSourceOccurrence = MemberReadSourceOccurrence | CallResultSourceOccurrence;

/** The sink side of a finding's identity: point + site + argument + binding. */
export interface TaintSinkOccurrence {
  readonly point: ProgramPoint;
  /** Index into the sink statement's `sites` array. */
  readonly siteIndex: number;
  /** Matched sink argument position the tainted occurrence landed in. */
  readonly argIndex: number;
  /**
   * The binding whose occurrence reached the sink position (for rule-(b)
   * findings: the source member-read's object binding).
   */
  readonly bindingIdx: number;
  /** The matched sink entry's `name` (e.g. `exec`) — finding classification. */
  readonly entryName: string;
}

export interface TaintFinding {
  readonly sinkKind: SinkKind;
  readonly source: TaintSourceOccurrence;
  readonly sink: TaintSinkOccurrence;
  /**
   * Ordered source→sink path, one path per finding (the CodeQL
   * `--max-paths=1` convention): the taint chain's def hops followed by the
   * sink-use hop. Rule-(b) findings carry the single sink-statement hop.
   */
  readonly hops: readonly TaintHop[];
  readonly hopsTruncated?: boolean;
}

/** A sanitizer that neutralized kinds on a flowing taint — U4's SANITIZES rows. */
export interface SanitizerKill {
  /** Statement point of the sanitizer call site. */
  readonly sanitizer: ProgramPoint;
  /**
   * The killed def's point (result-def kills — always the sanitizer's own
   * statement in the intra-statement model) or the suppressed sink
   * statement's point (value-position interposition kills).
   */
  readonly killedDef: ProgramPoint;
  /** The killed def's binding, or the interposed binding for value-position kills. */
  readonly bindingIdx: number;
  /** Sorted, deduped kinds the sanitizer neutralized at that position. */
  readonly neutralized: readonly SinkKind[];
}

export interface FunctionTaintResult {
  /**
   * `computed`     — full propagation ran.
   * `coverage-gap` — the solver result was not `computed`; the function is
   *                  skipped for findings entirely (R4: never partially
   *                  analyzed), `gapReason` carries the solver status.
   */
  readonly status: 'computed' | 'coverage-gap';
  readonly gapReason?: 'truncated' | 'overflow' | 'no-facts';
  /** Deduped (KTD6 identity), deterministically sorted, capped. */
  readonly findings: readonly TaintFinding[];
  readonly kills: readonly SanitizerKill[];
  /** Findings dropped by `maxFindingsPerFunction` (post-dedup). */
  readonly droppedFindings: number;
}

// Canonical SinkKind order + sort live in source-sink-config.ts (shared with
// the M4 summary harvest so the deterministic order never drifts); imported
// above as KIND_ORDER / sortKinds. `kindRank` is the local comparator index.
const kindRank = new Map<SinkKind, number>(KIND_ORDER.map((k, i) => [k, i]));

const EMPTY_KINDS: ReadonlySet<SinkKind> = new Set();

/** One intra-statement occurrence path (interposition evidence). */
interface OccPath {
  /** Kinds neutralized along the path (union of traversed sanitizer hops). */
  readonly kinds: ReadonlySet<SinkKind>;
  /** The path traverses an unmodeled call/new site. */
  readonly viaCall: boolean;
  /** Matched sanitizers traversed, with the kinds each contributed. */
  readonly sanitizers: ReadonlyArray<{ siteIndex: number; kinds: readonly SinkKind[] }>;
}

const DIRECT_PATH: OccPath = { kinds: EMPTY_KINDS, viaCall: false, sanitizers: [] };

/** Per-statement match/site context, indexed once per visited statement. */
interface StmtContext {
  readonly point: ProgramPoint;
  readonly facts: StatementFacts;
  readonly sites: readonly SiteRecord[];
  readonly sinksBySite: ReadonlyMap<number, readonly MatchedSinkCall[]>;
  readonly sanitizersBySite: ReadonlyMap<number, readonly MatchedSanitizerCall[]>;
  /** binding → site indices whose `resultDefs` contain it (kill targets). */
  readonly resultDefSites: ReadonlyMap<number, readonly number[]>;
}

/** One tainted (binding, defPoint) with the current minimal exclusion set. */
interface TaintState {
  readonly bindingIdx: number;
  readonly point: ProgramPoint;
  /** Mutable: only ever SHRINKS (intersection on re-derivation). */
  exclusions: ReadonlySet<SinkKind>;
  /** Taint-chain parent key, or undefined for seeds. */
  parentKey?: string;
  /** Root source occurrence the chain was seeded from. */
  source: TaintSourceOccurrence;
  viaCall: boolean;
  /** Exclusion-set size at last processing — skips no-op requeues. */
  processedSize: number;
}

/**
 * Compute taint flows for one function. See the module doc for the two-rule
 * model, the kind-set exclusion semantics, and the precision floor.
 */
export function computeTaintFlows(
  cfg: FunctionCfg,
  defUse: FunctionDefUse,
  matches: FunctionSiteMatches,
  limits?: TaintLimits,
): FunctionTaintResult {
  if (defUse.status !== 'computed') {
    return {
      status: 'coverage-gap',
      gapReason: defUse.status,
      findings: [],
      kills: [],
      droppedFindings: 0,
    };
  }

  const bindings = defUse.bindings;

  // ── per-statement context (built lazily; statements revisit often) ────────
  const matchByPoint = new Map<string, StatementMatches>();
  for (const sm of matches.statements) {
    matchByPoint.set(`${sm.blockIndex}:${sm.statementIndex}`, sm);
  }
  const ctxCache = new Map<string, StmtContext | undefined>();
  const contextAt = (blockIndex: number, stmtIndex: number): StmtContext | undefined => {
    const key = `${blockIndex}:${stmtIndex}`;
    if (ctxCache.has(key)) return ctxCache.get(key);
    const facts = cfg.blocks[blockIndex]?.statements?.[stmtIndex];
    let ctx: StmtContext | undefined;
    if (facts) {
      const sm = matchByPoint.get(key);
      const sinksBySite = new Map<number, MatchedSinkCall[]>();
      const sanitizersBySite = new Map<number, MatchedSanitizerCall[]>();
      for (const s of sm?.sinks ?? []) {
        const list = sinksBySite.get(s.siteIndex);
        if (list) list.push(s);
        else sinksBySite.set(s.siteIndex, [s]);
      }
      for (const s of sm?.sanitizers ?? []) {
        const list = sanitizersBySite.get(s.siteIndex);
        if (list) list.push(s);
        else sanitizersBySite.set(s.siteIndex, [s]);
      }
      const resultDefSites = new Map<number, number[]>();
      facts.sites?.forEach((site, siteIndex) => {
        for (const d of site.resultDefs ?? []) {
          const list = resultDefSites.get(d);
          if (list) list.push(siteIndex);
          else resultDefSites.set(d, [siteIndex]);
        }
      });
      ctx = {
        point: { blockIndex, stmtIndex, line: facts.line },
        facts,
        sites: facts.sites ?? [],
        sinksBySite,
        sanitizersBySite,
        resultDefSites,
      };
    }
    ctxCache.set(key, ctx);
    return ctx;
  };

  /** Kinds the matched sanitizers at `siteIndex` neutralize for input position `argPos`. */
  const neutralizedAt = (ctx: StmtContext, siteIndex: number, argPos: number): SinkKind[] => {
    const sans = ctx.sanitizersBySite.get(siteIndex);
    if (!sans) return [];
    const site = ctx.sites[siteIndex];
    // Spread/template positions are never provably the sanitized argument —
    // do not neutralize (sound: under-kill). Exact positions check `args`.
    if (site.template === true || (site.spread !== undefined && argPos >= site.spread)) return [];
    const kinds: SinkKind[] = [];
    for (const san of sans) {
      if (san.entry.args === undefined || san.entry.args.includes(argPos)) {
        kinds.push(...san.entry.neutralizes);
      }
    }
    return sortKinds(kinds);
  };

  /** A call/new site the model does not understand (anything but a matched sanitizer). */
  const isUnmodeledCall = (ctx: StmtContext, siteIndex: number): boolean => {
    const site = ctx.sites[siteIndex];
    return site.kind !== 'member-read' && !ctx.sanitizersBySite.has(siteIndex);
  };

  const emerge = (ctx: StmtContext, siteIndex: number, argPos: number, inner: OccPath): OccPath => {
    const added = neutralizedAt(ctx, siteIndex, argPos);
    return {
      kinds: added.length === 0 ? inner.kinds : new Set([...inner.kinds, ...added]),
      viaCall: inner.viaCall || isUnmodeledCall(ctx, siteIndex),
      sanitizers:
        added.length === 0 ? inner.sanitizers : [...inner.sanitizers, { siteIndex, kinds: added }],
    };
  };

  /**
   * STRICT occurrence paths of binding `b` flowing OUT of site `siteIndex`'s
   * result — found arg entries and the receiver only, each with the site's
   * own neutralization/viaCall applied. Empty when `b` provably never flows
   * in (the caller falls back to the floor and records NO kill). `guard`
   * breaks corrupted-store via cycles (site-safety checks ranges, not
   * acyclicity).
   */
  const flowsOutOf = (
    ctx: StmtContext,
    b: number,
    siteIndex: number,
    guard: Set<number>,
  ): OccPath[] => {
    if (guard.has(siteIndex)) return [];
    guard.add(siteIndex);
    const site = ctx.sites[siteIndex];
    const out: OccPath[] = [];
    site.args?.forEach((entries, argPos) => {
      for (const e of entries) {
        if (typeof e === 'number') {
          if (e === b) out.push(emerge(ctx, siteIndex, argPos, DIRECT_PATH));
        } else if (e[0] === b) {
          // Via-tagged: the occurrence reaches this position THROUGH the
          // nested site. When the nested site shows no recognized channel
          // for `b` (callee-chain occurrences — dynamic subscript keys), the
          // via-tag is still evidence of flow: fall back to a direct,
          // UN-neutralized path (sound: never a false kill).
          const inner = flowsOutOf(ctx, b, e[1], guard);
          const paths =
            inner.length > 0
              ? inner
              : [{ ...DIRECT_PATH, viaCall: isUnmodeledCall(ctx, e[1]) } satisfies OccPath];
          for (const p of paths) out.push(emerge(ctx, siteIndex, argPos, p));
        }
      }
    });
    if (site.receiver === b) {
      // Receiver TITO (KTD5): the receiver's value flows through the call
      // into its result — but a sanitizer does not neutralize its receiver.
      out.push({ ...DIRECT_PATH, viaCall: isUnmodeledCall(ctx, siteIndex) });
    }
    guard.delete(siteIndex);
    return out;
  };

  /** Occurrence paths of `b` INTO sink position (s, p) — no emergence from s. */
  const pathsIntoPosition = (
    ctx: StmtContext,
    b: number,
    siteIndex: number,
    argPos: number,
  ): OccPath[] => {
    const entries = ctx.sites[siteIndex].args?.[argPos] ?? [];
    const out: OccPath[] = [];
    for (const e of entries) {
      if (typeof e === 'number') {
        if (e === b) out.push(DIRECT_PATH);
      } else if (e[0] === b) {
        const inner = flowsOutOf(ctx, b, e[1], new Set());
        if (inner.length > 0) out.push(...inner);
        else out.push({ ...DIRECT_PATH, viaCall: isUnmodeledCall(ctx, e[1]) });
      }
    }
    return out;
  };

  /**
   * Walk a SOURCE member-read's `parent` chain. Linear (each site has one
   * parent); invokes `onPosition` with the accumulated path BEFORE the
   * ancestor's own emergence (the value flows INTO the ancestor at that
   * position) — sink checks and stop-at-site joins both hang off it.
   */
  const climbSourceChain = (
    ctx: StmtContext,
    srcSiteIndex: number,
    onPosition: (siteIndex: number, argPos: number, sofar: OccPath) => boolean,
  ): void => {
    const visited = new Set<number>([srcSiteIndex]);
    let cur = ctx.sites[srcSiteIndex];
    let sofar: OccPath = DIRECT_PATH;
    while (cur.parent) {
      const [siteIndex, argPos] = cur.parent;
      if (visited.has(siteIndex)) return; // corrupted-store parent cycle
      visited.add(siteIndex);
      if (onPosition(siteIndex, argPos, sofar)) return;
      sofar = emerge(ctx, siteIndex, argPos, sofar);
      cur = ctx.sites[siteIndex];
    }
  };

  /** Source path INTO site `target` (with target's emergence), or undefined. */
  const sourceFlowsOutOf = (
    ctx: StmtContext,
    srcSiteIndex: number,
    target: number,
  ): OccPath | undefined => {
    let found: OccPath | undefined;
    climbSourceChain(ctx, srcSiteIndex, (siteIndex, argPos, sofar) => {
      if (siteIndex !== target) return false;
      found = emerge(ctx, target, argPos, sofar);
      return true;
    });
    return found;
  };

  // ── accumulators ──────────────────────────────────────────────────────────
  const findingsByIdentity = new Map<string, TaintFinding>();
  const killsByIdentity = new Map<
    string,
    { kill: Omit<SanitizerKill, 'neutralized'>; kinds: Set<SinkKind> }
  >();

  const recordKill = (
    sanitizer: ProgramPoint,
    killedDef: ProgramPoint,
    bindingIdx: number,
    kinds: readonly SinkKind[],
  ): void => {
    if (kinds.length === 0) return;
    const key = `${pointKey(sanitizer)}|${pointKey(killedDef)}|${bindingIdx}`;
    const existing = killsByIdentity.get(key);
    if (existing) for (const k of kinds) existing.kinds.add(k);
    else
      killsByIdentity.set(key, {
        kill: { sanitizer, killedDef, bindingIdx },
        kinds: new Set(kinds),
      });
  };

  // KTD6 statement-level finding identity: source occurrence + sink occurrence
  // + kind (NOT entryName). Computed standalone so the worklist can dedup-check
  // BEFORE the cost of chainHops (first write wins; dedup-before-budget).
  const findingKey = (
    sinkKind: SinkKind,
    source: TaintSourceOccurrence,
    sink: Pick<TaintSinkOccurrence, 'point' | 'siteIndex' | 'argIndex' | 'bindingIdx'>,
  ): string => {
    if (source.type === 'member-read') {
      return [
        sinkKind,
        pointKey(source.point),
        source.siteIndex,
        source.objectBindingIdx,
        source.property,
        pointKey(sink.point),
        sink.siteIndex,
        sink.argIndex,
        sink.bindingIdx,
      ].join('|');
    }
    return [
      sinkKind,
      pointKey(source.point),
      source.siteIndex,
      source.type,
      source.resultBindingIdx,
      source.calleeName,
      pointKey(sink.point),
      sink.siteIndex,
      sink.argIndex,
      sink.bindingIdx,
    ].join('|');
  };

  const recordFinding = (
    sinkKind: SinkKind,
    source: TaintSourceOccurrence,
    sink: TaintSinkOccurrence,
    hops: TaintHop[],
    hopsTruncated: boolean,
  ): void => {
    const key = findingKey(sinkKind, source, sink);
    if (findingsByIdentity.has(key)) return;
    const maxHops = limits?.maxHops && limits.maxHops > 0 ? limits.maxHops : Infinity;
    let truncated = hopsTruncated;
    let kept = hops;
    if (hops.length > maxHops) {
      kept = hops.slice(0, maxHops);
      truncated = true;
    }
    findingsByIdentity.set(key, {
      sinkKind,
      source,
      sink,
      hops: kept,
      ...(truncated ? { hopsTruncated: true } : {}),
    });
  };

  // ── taint state ───────────────────────────────────────────────────────────
  const taints = new Map<string, TaintState>();
  const queue: string[] = [];

  /** The (binding, def-point) portion of a state key — the def→use fact-table
   *  lookup key, source-independent. */
  const defKey = (bindingIdx: number, point: ProgramPoint): string =>
    `${bindingIdx}:${pointKey(point)}`;
  /** Full taint-state key: the def-point portion plus a ROOT source-occurrence
   *  discriminator ({point, siteIndex} — the same source fields recordFinding's
   *  identity uses, deliberately excluding `kind`). Distinct sources reaching
   *  one def get distinct states, so a second source is no longer dropped
   *  (KTD6); same-source multi-path derivations still share a key so their
   *  exclusion sets intersect (the raw arm soundly wins). */
  const stateKey = (
    bindingIdx: number,
    point: ProgramPoint,
    source: TaintSourceOccurrence,
  ): string => `${defKey(bindingIdx, point)}#${pointKey(source.point)}:${source.siteIndex}`;

  const deriveTaint = (
    bindingIdx: number,
    point: ProgramPoint,
    exclusions: ReadonlySet<SinkKind>,
    parentKey: string | undefined,
    source: TaintSourceOccurrence,
    viaCall: boolean,
  ): void => {
    const key = stateKey(bindingIdx, point, source);
    const existing = taints.get(key);
    if (!existing) {
      taints.set(key, {
        bindingIdx,
        point,
        exclusions,
        parentKey,
        source,
        viaCall,
        processedSize: -1,
      });
      queue.push(key);
      return;
    }
    // Monotone shrink: keep the intersection; re-process only when it got
    // strictly smaller (a less-neutralized derivation is more dangerous).
    const inter = new Set<SinkKind>();
    for (const k of existing.exclusions) if (exclusions.has(k)) inter.add(k);
    if (inter.size < existing.exclusions.size) {
      existing.exclusions = inter;
      existing.parentKey = parentKey;
      existing.source = source;
      existing.viaCall = viaCall;
      queue.push(key);
    }
  };

  /** Taint-chain hops from seed to `key`, with a cycle guard (re-derivation
   *  can rewire parents into a loop — truncate instead of spinning). */
  const chainHops = (key: string): { hops: TaintHop[]; truncated: boolean } => {
    const reversed: TaintHop[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = key;
    let truncated = false;
    while (cur !== undefined) {
      if (seen.has(cur)) {
        truncated = true;
        break;
      }
      seen.add(cur);
      const t = taints.get(cur);
      if (!t) break;
      reversed.push({
        bindingIdx: t.bindingIdx,
        name: bindings[t.bindingIdx]?.name ?? `#${t.bindingIdx}`,
        point: t.point,
        ...(t.viaCall ? { viaCall: true } : {}),
      });
      cur = t.parentKey;
    }
    return { hops: reversed.reverse(), truncated };
  };

  /** Intersection of path kind-sets; viaCall = any path through a call. */
  const summarizePaths = (
    paths: readonly OccPath[],
  ): { kinds: ReadonlySet<SinkKind>; viaCall: boolean } => {
    let kinds: ReadonlySet<SinkKind> | undefined;
    let viaCall = false;
    for (const p of paths) {
      viaCall ||= p.viaCall;
      if (kinds === undefined) {
        kinds = p.kinds;
      } else {
        const inter = new Set<SinkKind>();
        for (const k of kinds) if (p.kinds.has(k)) inter.add(k);
        kinds = inter;
      }
    }
    return { kinds: kinds ?? EMPTY_KINDS, viaCall };
  };

  /**
   * Taint every def of `ctx`'s statement from one input. `pathsInto(c)`
   * supplies the input's strict occurrence paths into call site `c` —
   * defining the resultDefs precision and the kill evidence; an empty list
   * means "no provable flow" and the floor applies (taint with the input's
   * own exclusions, no kill).
   */
  const feedDefs = (
    ctx: StmtContext,
    inputExclusions: ReadonlySet<SinkKind>,
    parentKey: string | undefined,
    source: TaintSourceOccurrence,
    pathsInto: (siteIndex: number) => OccPath[],
  ): void => {
    const defs = [...ctx.facts.defs, ...(ctx.facts.mayDefs ?? [])];
    if (defs.length === 0) return;
    const seen = new Set<number>();
    for (const d of defs) {
      if (seen.has(d)) continue;
      seen.add(d);
      const rdSites = ctx.resultDefSites.get(d);
      let addKinds: ReadonlySet<SinkKind> = EMPTY_KINDS;
      let viaCall = false;
      if (rdSites) {
        const paths: OccPath[] = [];
        for (const c of rdSites) paths.push(...pathsInto(c));
        if (paths.length > 0) {
          const summary = summarizePaths(paths);
          addKinds = summary.kinds;
          viaCall = summary.viaCall;
          for (const p of paths) {
            for (const san of p.sanitizers) {
              recordKill(ctx.point, ctx.point, d, san.kinds);
            }
          }
        }
        // else: floor — tainted with no exclusions added, no kill (the input
        // provably never flows into the producing call; conflation FP pinned).
      }
      const exclusions =
        addKinds.size === 0 ? inputExclusions : new Set([...inputExclusions, ...addKinds]);
      deriveTaint(d, ctx.point, exclusions, parentKey, source, viaCall);
    }
  };

  // ── rule (b) + seeding: statements with matched sources ───────────────────
  for (const sm of matches.statements) {
    if (sm.sources.length === 0) continue;
    const ctx = contextAt(sm.blockIndex, sm.statementIndex);
    if (!ctx) continue;
    for (const src of sm.sources) {
      if (src.type === 'call-result') {
        const srcSite = ctx.sites[src.siteIndex];
        if (srcSite?.callee === undefined) continue;
        const calleeName = srcSite.callee;
        for (const d of src.resultDefs) {
          const sourceOcc: CallResultSourceOccurrence = {
            point: ctx.point,
            siteIndex: src.siteIndex,
            type: 'call-result',
            resultBindingIdx: d,
            calleeName,
            kind: src.entry.kind,
          };
          deriveTaint(d, ctx.point, EMPTY_KINDS, undefined, sourceOcc, false);
        }
        continue;
      }
      const srcSite = ctx.sites[src.siteIndex];
      if (srcSite?.object === undefined || srcSite.property === undefined) continue;
      const sourceOcc: MemberReadSourceOccurrence = {
        point: ctx.point,
        siteIndex: src.siteIndex,
        type: 'member-read',
        objectBindingIdx: srcSite.object,
        property: srcSite.property,
        kind: src.entry.kind,
      };

      // Statement-local sink checks along the member-read's parent chain.
      climbSourceChain(ctx, src.siteIndex, (siteIndex, argPos, sofar) => {
        for (const sink of ctx.sinksBySite.get(siteIndex) ?? []) {
          if (!sink.argPositions.includes(argPos)) continue;
          const kind = sink.entry.kind;
          if (!sofar.kinds.has(kind)) {
            recordFinding(
              kind,
              sourceOcc,
              {
                point: ctx.point,
                siteIndex,
                argIndex: argPos,
                bindingIdx: srcSite.object as number,
                entryName: sink.entry.name,
              },
              [
                {
                  bindingIdx: srcSite.object as number,
                  name: bindings[srcSite.object as number]?.name ?? `#${srcSite.object}`,
                  point: ctx.point,
                  ...(sofar.viaCall ? { viaCall: true } : {}),
                },
              ],
              false,
            );
          } else {
            for (const san of sofar.sanitizers) {
              if (san.kinds.includes(kind)) {
                recordKill(ctx.point, ctx.point, srcSite.object as number, san.kinds);
              }
            }
          }
        }
        return false;
      });

      // Seed every def of the statement (precision floor + resultDefs kills).
      feedDefs(ctx, EMPTY_KINDS, undefined, sourceOcc, (c) => {
        const p = sourceFlowsOutOf(ctx, src.siteIndex, c);
        return p ? [p] : [];
      });
    }
  }

  // ── rule (a): worklist over def→use facts ─────────────────────────────────
  const factsByDef = new Map<string, DefUseFact[]>();
  for (const f of defUse.facts) {
    const key = defKey(f.bindingIdx, f.def);
    const list = factsByDef.get(key);
    if (list) list.push(f);
    else factsByDef.set(key, [f]);
  }

  // Strict-FIFO worklist via a head cursor (not Array.shift, which is O(N) per
  // dequeue). FIFO order is load-bearing beyond perf: chainHops reconstructs
  // hops from the live `taints` map, whose parentKey/source/viaCall are
  // rewritten order-sensitively on monotone shrink — so hop-content
  // determinism is contingent on dequeue order matching enqueue order. Do NOT
  // sort or reprioritize the worklist.
  let head = 0;
  while (head < queue.length) {
    const key = queue[head++];
    // Reclaim the consumed prefix periodically so the array doesn't grow
    // unbounded across a long run (order-preserving — pure memory hygiene).
    if (head > 1024 && head * 2 > queue.length) {
      queue.splice(0, head);
      head = 0;
    }
    const t = taints.get(key) as TaintState;
    if (t.processedSize === t.exclusions.size) continue; // no-op requeue
    t.processedSize = t.exclusions.size;
    const b = t.bindingIdx;
    const E = t.exclusions;

    // Facts are keyed by (binding, def-point) only — look up by the def portion
    // of this state, not the source-discriminated state key.
    for (const fact of factsByDef.get(defKey(b, t.point)) ?? []) {
      const ctx = contextAt(fact.use.blockIndex, fact.use.stmtIndex);
      if (!ctx) continue;

      // Sink check: occurrences of `b` at matched sink argument positions.
      for (const [siteIndex, sinks] of ctx.sinksBySite) {
        for (const sink of sinks) {
          const kind = sink.entry.kind;
          for (const argPos of sink.argPositions) {
            const paths = pathsIntoPosition(ctx, b, siteIndex, argPos);
            if (paths.length === 0) continue;
            if (E.has(kind)) continue; // suppressed at def time; kill already recorded
            const justify = paths.find((p) => !p.kinds.has(kind));
            if (justify) {
              const sinkOcc = {
                point: ctx.point,
                siteIndex,
                argIndex: argPos,
                bindingIdx: b,
                entryName: sink.entry.name,
              };
              // Dedup BEFORE chainHops: already-recorded identities discard
              // their hop chain anyway (first write wins), so skip the walk.
              if (findingsByIdentity.has(findingKey(kind, t.source, sinkOcc))) continue;
              const chain = chainHops(key);
              chain.hops.push({
                bindingIdx: b,
                name: bindings[b]?.name ?? `#${b}`,
                point: ctx.point,
                ...(justify.viaCall ? { viaCall: true } : {}),
              });
              recordFinding(kind, t.source, sinkOcc, chain.hops, chain.truncated);
            } else {
              // EVERY path interposed — value-position kill(s) held.
              for (const p of paths) {
                for (const san of p.sanitizers) {
                  if (san.kinds.includes(kind)) recordKill(ctx.point, ctx.point, b, san.kinds);
                }
              }
            }
          }
        }
      }

      // Def-feed: the use statement's own defs become tainted.
      feedDefs(ctx, E, key, t.source, (c) => flowsOutOf(ctx, b, c, new Set()));
    }
  }

  // ── deterministic assembly ────────────────────────────────────────────────
  const comparePoints = (a: ProgramPoint, b: ProgramPoint): number =>
    a.blockIndex - b.blockIndex || a.stmtIndex - b.stmtIndex;

  const findings = [...findingsByIdentity.values()].sort(
    (a, b) =>
      comparePoints(a.source.point, b.source.point) ||
      a.source.siteIndex - b.source.siteIndex ||
      comparePoints(a.sink.point, b.sink.point) ||
      a.sink.siteIndex - b.sink.siteIndex ||
      a.sink.argIndex - b.sink.argIndex ||
      a.sink.bindingIdx - b.sink.bindingIdx ||
      (kindRank.get(a.sinkKind) ?? 99) - (kindRank.get(b.sinkKind) ?? 99),
  );
  const maxFindings =
    limits?.maxFindingsPerFunction && limits.maxFindingsPerFunction > 0
      ? limits.maxFindingsPerFunction
      : Infinity;
  const kept = findings.length > maxFindings ? findings.slice(0, maxFindings) : findings;

  const kills = [...killsByIdentity.values()]
    .map(({ kill, kinds }) => ({ ...kill, neutralized: sortKinds(kinds) }))
    .sort(
      (a, b) =>
        comparePoints(a.sanitizer, b.sanitizer) ||
        comparePoints(a.killedDef, b.killedDef) ||
        a.bindingIdx - b.bindingIdx,
    );

  return {
    status: 'computed',
    findings: kept,
    kills,
    droppedFindings: findings.length - kept.length,
  };
}
