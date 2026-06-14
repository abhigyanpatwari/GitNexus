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

  /** Open a call/new site; parent = innermost enclosing argument position. */
  openCallSite(kind: 'call' | 'new'): number {
    const site: MutableSite = { kind };
    const parent = this.innermostArgPosition();
    if (parent) site.parent = parent;
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
    this.sites[siteIdx].callee = callee;
  }

  setSiteReceiver(siteIdx: number, receiver: number): void {
    this.sites[siteIdx].receiver = receiver;
  }

  setSiteResultDefs(siteIdx: number, resultDefs: readonly number[]): void {
    this.sites[siteIdx].resultDefs = [...resultDefs];
  }

  setSiteSpread(siteIdx: number, firstSpreadArg: number): void {
    const site = this.sites[siteIdx];
    if (site.spread === undefined) site.spread = firstSpreadArg;
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
      const via = i + 1 < this.frames.length ? this.frames[i + 1].siteIdx : undefined;
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
