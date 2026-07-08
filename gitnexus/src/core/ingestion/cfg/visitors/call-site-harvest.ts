/**
 * Shared call-site taint substrate for the C-family CFG harvesters (#2195 U6,
 * plan R7 / KTD2) — the language-agnostic mechanism the C/C++, C#, Java and Go
 * harvesters layer their grammar-specific call/member walks on top of.
 *
 * This file is PURE MECHANISM: it contains no tree-sitter node-type or field
 * literals (each harvester supplies those when it drives `openCallSite` /
 * `addMemberRead` / `setFrameArg`), so it names no language and carries nothing
 * the grammar-literal CI gate needs to validate. It is the C-family analogue of
 * the `FactAccumulator` site machinery in
 * {@link import('./typescript-harvest.js')} — extracted into one place because
 * the four C-family harvesters already share an identical def/use accumulator,
 * and the site layer is identical across them too (only the per-grammar node
 * shapes differ, and those live in each harvester's `walkValue`/`visitCall`).
 *
 * Produces the same {@link SiteRecord} shape the (future, deferred) shared
 * taint matcher consumes uniformly across all languages: callee path, receiver,
 * per-argument occurrence entries (with sanitizer-interposition via-tags),
 * result defs, spread/template markers, and member reads. INERT BY DESIGN — no
 * C-family source/sink/sanitizer model is registered today (`getSourceSinkConfig`
 * returns undefined for every C-family language), so a harvest with no model
 * produces ZERO TAINTED edges; this only emits the substrate the deferred model
 * work will match against.
 *
 * Sites are emitted on {@link StatementFacts.sites} only when non-empty, exactly
 * like the TS harvester — flag-off runs never harvest, and most fact-bearing
 * statements carry no calls.
 *
 * NOTE: nothing serialized here may carry a field named `nodeId` — the durable
 * parsedfile-store reviver dedups objects keyed on that field name.
 */
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { SiteArgOccurrence, SiteRecord, StatementFacts } from '../types.js';

/** Mutable build-time view of a {@link SiteRecord}. */
interface MutableSite {
  kind: SiteRecord['kind'];
  parent?: [number, number];
  callee?: string;
  receiver?: number;
  args?: SiteArgOccurrence[][];
  resultDefs?: number[];
  spread?: number;
  template?: boolean;
  requireArg?: string;
  object?: number;
  property?: string;
  /** Call-site anchor position — see {@link SiteRecord.at}. Call/new only. */
  at?: [number, number];
}

/**
 * One open call/new site during the walk (mirrors the TS `SiteFrame`). `argIdx`
 * is the argument position currently being walked, or -1 while outside any
 * argument (callee walk) — occurrences recorded then do NOT land in this frame's
 * args, but still fan out (via-tagged) to enclosing arg-active frames.
 */
interface SiteFrame {
  siteIdx: number;
  argIdx: number;
}

/**
 * Minimal ordered, deduplicating def/use collector for one statement record,
 * with NO call-site machinery (#2195 U7). The Kotlin / Python / Ruby / Rust /
 * Dart / Swift harvesters each carried a BYTE-IDENTICAL copy of this class:
 * those units harvest NO call sites (the taint substrate is a later step), so a
 * site-free accumulator keeps their emitted facts free of any `sites` key
 * (matching the Python harvester) and byte-identical to one another. This is the
 * no-site sibling of {@link CallSiteFactAccumulator}; `finish` omits `sites`
 * entirely. `useCount` is live (Ruby's emit guard is `defCount() ||
 * useCount()`).
 */
export class DefUseAccumulator {
  private readonly defs: number[] = [];
  private readonly uses: number[] = [];
  private readonly mayDefs: number[] = [];
  private readonly defSeen = new Set<number>();
  private readonly useSeen = new Set<number>();
  private readonly mayDefSeen = new Set<number>();

  constructor(private readonly line: number) {}

  addDef(idx: number): void {
    if (this.defSeen.has(idx)) return;
    this.defSeen.add(idx);
    this.defs.push(idx);
  }

  /** A def that may not execute (conditional context) — gen without kill. */
  addMayDef(idx: number): void {
    if (this.mayDefSeen.has(idx)) return;
    this.mayDefSeen.add(idx);
    this.mayDefs.push(idx);
  }

  addUse(idx: number): void {
    if (this.useSeen.has(idx)) return;
    this.useSeen.add(idx);
    this.uses.push(idx);
  }

  defCount(): number {
    return this.defs.length + this.mayDefs.length;
  }

  useCount(): number {
    return this.uses.length;
  }

  finish(): StatementFacts {
    return {
      line: this.line,
      defs: this.defs,
      uses: this.uses,
      // Stay absent when empty — keeps the serialized side-channel payload lean.
      ...(this.mayDefs.length > 0 ? { mayDefs: this.mayDefs } : {}),
    };
  }
}

/**
 * Defensive per-statement cap on harvested taint `sites` (#2195 U11). A real
 * statement carries a handful of call / member-read sites; this only bounds a
 * pathological or machine-generated statement (e.g. hundreds of nested calls)
 * from producing an unbounded site list. Mirrors the PDG edge/fact caps' style
 * (a generous-but-finite limit, checked before each push). Overflow is silent
 * but observable via {@link CallSiteFactAccumulator.sitesTruncated}; the first
 * `DEFAULT_PDG_MAX_SITES_PER_STATEMENT` sites are kept fully intact (callee,
 * args, parent), the over-cap tail is dropped.
 */
export const DEFAULT_PDG_MAX_SITES_PER_STATEMENT = 512;

/**
 * Ordered, deduplicating def/use collector for one statement record, PLUS the
 * call-site harvest machinery (#2195 U6). A drop-in superset of the simple
 * def/use accumulator the C-family harvesters used before the substrate landed
 * — `addDef`/`addMayDef`/`addUse`/`defCount`/`useCount`/`finish` are unchanged,
 * so harvesters that never open a site emit byte-identical facts (no `sites`
 * key, since `finish` omits it when empty).
 */
export class CallSiteFactAccumulator {
  private readonly defs: number[] = [];
  private readonly uses: number[] = [];
  private readonly mayDefs: number[] = [];
  private readonly defSeen = new Set<number>();
  private readonly useSeen = new Set<number>();
  private readonly mayDefSeen = new Set<number>();
  /** Taint sites recorded for this statement. */
  private readonly sites: MutableSite[] = [];
  /** Composite (object|property|parent) keys of recorded member-read sites — O(1) dedup. */
  private readonly memberReadKeys = new Set<string>();
  /** Stack of open call/new sites — the occurrence fan-out targets. */
  private readonly frames: SiteFrame[] = [];
  /** Set once the per-statement site cap is hit; over-cap sites are dropped. */
  private _sitesTruncated = false;

  constructor(private readonly line: number) {}

  /** True iff this statement hit {@link DEFAULT_PDG_MAX_SITES_PER_STATEMENT}. */
  get sitesTruncated(): boolean {
    return this._sitesTruncated;
  }

  addDef(idx: number): void {
    if (this.defSeen.has(idx)) return;
    this.defSeen.add(idx);
    this.defs.push(idx);
  }

  /** A def that may not execute (conditional context) — gen without kill. */
  addMayDef(idx: number): void {
    if (this.mayDefSeen.has(idx)) return;
    this.mayDefSeen.add(idx);
    this.mayDefs.push(idx);
  }

  addUse(idx: number): void {
    // Occurrence fan-out happens BEFORE the statement-level dedup: `exec(x, x)`
    // records x at BOTH arg positions even though `uses` lists it once.
    this.recordOccurrence(idx);
    this.addUseWithoutOccurrence(idx);
  }

  /**
   * Statement-level use that is NOT a value occurrence in any open site
   * argument — bare callee names only (see each harvester's `visitCall`).
   */
  addUseWithoutOccurrence(idx: number): void {
    if (this.useSeen.has(idx)) return;
    this.useSeen.add(idx);
    this.uses.push(idx);
  }

  defCount(): number {
    return this.defs.length + this.mayDefs.length;
  }

  useCount(): number {
    return this.uses.length;
  }

  // ── site machinery (#2195 U6, mirrors the TS harvester) ──────────────────

  /** `[defs.length, mayDefs.length]` marker for {@link defsSince}. */
  defSnapshot(): readonly [number, number] {
    return [this.defs.length, this.mayDefs.length];
  }

  /** Binding indices def'd (must- OR may-) since the snapshot was taken. */
  defsSince(snap: readonly [number, number]): number[] {
    return [...this.defs.slice(snap[0]), ...this.mayDefs.slice(snap[1])];
  }

  /**
   * Open a call/new site; parent = innermost enclosing argument position.
   * Returns the new site index, or -1 when the per-statement site cap is hit
   * (the caller threads -1 through `pushFrame`/`setSite*`, all of which no-op on
   * a sentinel index — see {@link DEFAULT_PDG_MAX_SITES_PER_STATEMENT}).
   *
   * `at` is the call/new node's anchor position `[line (1-based), col (0-based)]`
   * — the SAME position the CALLS-edge resolution keys on (see
   * {@link SiteRecord.at} for the KTD7 alignment); the harvester passes its
   * `visitCall`/`visitNew` node's `startPosition` so the downstream resolved-id
   * join lands by exact position.
   */
  openCallSite(kind: 'call' | 'new', at?: readonly [number, number]): number {
    if (this.sites.length >= DEFAULT_PDG_MAX_SITES_PER_STATEMENT) {
      this._sitesTruncated = true;
      return -1;
    }
    const site: MutableSite = { kind };
    const parent = this.innermostArgPosition();
    if (parent) site.parent = parent;
    if (at) site.at = [at[0], at[1]];
    this.sites.push(site);
    return this.sites.length - 1;
  }

  pushFrame(siteIdx: number): void {
    this.frames.push({ siteIdx, argIdx: -1 });
  }

  popFrame(): void {
    this.frames.pop();
  }

  /** Set the argument position the top frame is currently walking. */
  setFrameArg(argIdx: number): void {
    const top = this.frames[this.frames.length - 1];
    if (top) top.argIdx = argIdx;
  }

  /**
   * Run `fn` with all open arg frames temporarily detached (argIdx = -1), so
   * identifier reads inside still record USES but do NOT fan occurrences into
   * the enclosing sink-argument position (e.g. the non-value operands of a
   * comma expression — only the final operand's value flows).
   */
  suppressOccurrences(fn: () => void): void {
    const saved = this.frames.map((f) => f.argIdx);
    for (const f of this.frames) f.argIdx = -1;
    try {
      fn();
    } finally {
      this.frames.forEach((f, i) => {
        f.argIdx = saved[i];
      });
    }
  }

  setSiteCallee(siteIdx: number, callee: string): void {
    const site = this.sites[siteIdx];
    if (site) site.callee = callee;
  }

  setSiteReceiver(siteIdx: number, receiver: number): void {
    const site = this.sites[siteIdx];
    if (site) site.receiver = receiver;
  }

  setSiteResultDefs(siteIdx: number, resultDefs: readonly number[]): void {
    const site = this.sites[siteIdx];
    if (site) site.resultDefs = [...resultDefs];
  }

  setSiteSpread(siteIdx: number, firstSpreadArg: number): void {
    const site = this.sites[siteIdx];
    if (site && site.spread === undefined) site.spread = firstSpreadArg;
  }

  /**
   * Record a value-position member read. Exact duplicates within the statement
   * (same object/property/parent position) dedup; reads at DIFFERENT argument
   * positions stay distinct (`exec(req.body, req.body)` is two occurrences).
   */
  addMemberRead(object: number, property: string): void {
    const parent = this.innermostArgPosition();
    const dedupKey = `${object}|${property}|${parent ? `${parent[0]}:${parent[1]}` : 'top'}`;
    if (this.memberReadKeys.has(dedupKey)) return;
    if (this.sites.length >= DEFAULT_PDG_MAX_SITES_PER_STATEMENT) {
      this._sitesTruncated = true;
      return;
    }
    this.memberReadKeys.add(dedupKey);
    const site: MutableSite = { kind: 'member-read' };
    if (parent) site.parent = parent;
    site.object = object;
    site.property = property;
    this.sites.push(site);
  }

  private innermostArgPosition(): [number, number] | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i];
      if (f.argIdx >= 0) return [f.siteIdx, f.argIdx];
    }
    return undefined;
  }

  /**
   * Fan a binding occurrence out to every arg-active open frame, via-tagged
   * with the site of the IMMEDIATELY nested frame when one exists:
   * `exec(escape(x))` puts a plain `x` in escape's arg 0 and `[x, escapeIdx]`
   * in exec's arg 0 — the sanitizer-interposition substrate.
   */
  private recordOccurrence(idx: number): void {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i];
      if (f.argIdx < 0) continue;
      // A nested frame whose site was cap-dropped (siteIdx -1) is not a real via.
      const next = i + 1 < this.frames.length ? this.frames[i + 1].siteIdx : undefined;
      const via = next !== undefined && next >= 0 ? next : undefined;
      this.pushArgEntry(f.siteIdx, f.argIdx, idx, via);
    }
  }

  private pushArgEntry(
    siteIdx: number,
    argIdx: number,
    bindingIdx: number,
    via: number | undefined,
  ): void {
    const site = this.sites[siteIdx];
    if (!site) return; // cap-dropped frame (siteIdx -1) — no target to fan into
    const args = (site.args ??= []);
    while (args.length <= argIdx) args.push([]);
    const list = args[argIdx];
    // Dedup exact (binding, via) pairs per position — `f(x + x)` is one entry;
    // `f(x + g(x))` keeps the plain AND the via-tagged entry (distinct paths).
    for (const e of list) {
      const match =
        typeof e === 'number'
          ? via === undefined && e === bindingIdx
          : via !== undefined && e[0] === bindingIdx && e[1] === via;
      if (match) return;
    }
    list.push(via === undefined ? bindingIdx : [bindingIdx, via]);
  }

  finish(): StatementFacts {
    return {
      line: this.line,
      defs: this.defs,
      uses: this.uses,
      // Optional fields stay absent when empty — keeps the serialized
      // side-channel payload lean (most statements have no may-defs / sites).
      ...(this.mayDefs.length > 0 ? { mayDefs: this.mayDefs } : {}),
      ...(this.sites.length > 0 ? { sites: this.sites.map(finalizeSite) } : {}),
    };
  }
}

/** Trim trailing empty arg positions; drop `args` entirely when all-empty. */
const finalizeSite = (site: MutableSite): SiteRecord => {
  const args = site.args;
  if (args !== undefined) {
    let end = args.length;
    while (end > 0 && args[end - 1].length === 0) end--;
    if (end === 0) delete site.args;
    else if (end < args.length) site.args = args.slice(0, end);
  }
  return site as SiteRecord;
};

/**
 * Per-grammar hooks the shared {@link finalizeChain} terminal needs but cannot
 * name itself (it carries no tree-sitter literals — see the file header). Each
 * harvester supplies the two callbacks bound to its own `this`.
 */
export interface ChainTerminalHooks {
  /** Resolve a binding-target node to its function-table binding index. */
  resolve(node: SyntaxNode): number;
  /**
   * Walk a NON-identifier chain root for its uses + nested sites (the terminal's
   * `else` branch — `self.x.f()`, `foo().bar`, a tuple index, etc.).
   */
  walkRoot(node: SyntaxNode): void;
}

/**
 * Shared `walkChain` TERMINAL (#2227 follow-up, plan KTD5/U8) — the byte-identical
 * post-unwind block the Go / Kotlin / Swift / Rust / Python harvesters all ran
 * after walking their grammar-specific access chain (`selector_expression` /
 * `navigation_expression` / `field_expression` / `attribute`) into an
 * `accesses: string[]` list and a resolved root node `cur`.
 *
 * It records the chain-root identifier as a use, emits at most ONE member-read
 * site — the INNERMOST access — when the root is an identifier (suppressed by
 * `skipFinalRead` when that access IS the callee, carried by the dotted path
 * instead), and builds the dotted path `[root, ...accesses].join('.')`. The only
 * per-grammar bit is the root identifier node type, supplied via `isRootIdType`
 * (`'identifier'` for Go/Rust/Python, `'simple_identifier'` for Kotlin/Swift);
 * the `resolve` / `walkRoot` callbacks bind the harvester's own methods. The
 * `addUse` / `addMemberRead` machinery is on the accumulator itself, so it is
 * called directly (no callback). Behavior is identical to the inlined terminals
 * this replaces — the per-language harvest tests are the characterization lock.
 */
export function finalizeChain(
  acc: CallSiteFactAccumulator,
  cur: SyntaxNode,
  accesses: readonly string[],
  skipFinalRead: boolean,
  isRootIdType: (type: string) => boolean,
  hooks: ChainTerminalHooks,
): { path?: string; rootIdx?: number } {
  let rootIdx: number | undefined;
  let rootSegment: string | undefined;
  if (isRootIdType(cur.type) && cur.text !== '_') {
    rootIdx = hooks.resolve(cur);
    acc.addUse(rootIdx);
    rootSegment = cur.text;
  } else {
    hooks.walkRoot(cur);
  }
  const innermost = accesses[0];
  if (rootIdx !== undefined && innermost && !(skipFinalRead && accesses.length === 1)) {
    acc.addMemberRead(rootIdx, innermost);
  }
  const path =
    rootSegment !== undefined && accesses.every((a) => a !== '')
      ? [rootSegment, ...accesses].join('.')
      : undefined;
  return { path, rootIdx };
}
