/**
 * Shared scope-tree substrate for the C-family / Go / Java / C# def/use
 * harvesters (#2197 U6, plan KTD4 — a byte-equivalent consolidation).
 *
 * The Go ({@link import('./go-harvest.js').GoHarvester}), Java ({@link
 * import('./java-harvest.js').JavaHarvester}), C# ({@link
 * import('./csharp-harvest.js').CsharpHarvester}) and C/C++ ({@link
 * import('./c-cpp-harvest.js').CCppHarvester}) harvesters each carried a
 * BYTE-IDENTICAL copy of the lexical scope tree machinery: the {@link Scope}
 * record, the binding/scope/synthetic state, the two-phase resolution cache, and
 * the `openScope` / `nearestScopeOf` / `resolve` / `def` / `use` / `conditional`
 * / `bindingTable` methods. This base holds that one copy; the four harvesters
 * extend it and supply ONLY their genuine per-language variation — the
 * `prescan` switch (abstract) and, for Go, the blank-identifier (`_`) overrides
 * of `declare` / `def` / `use`.
 *
 * TWO-PHASE, ORDER-INDEPENDENT (load-bearing): the CFG walk is NOT source-order
 * (`visitFor` builds the init block after the body, `visitDoWhile` the condition
 * before the body), so resolving names against a scope stack populated *during*
 * the walk would mis-resolve. Phase 1 (`prescan`, per-language) pre-scans the
 * whole function subtree once into a completed lexical scope tree; phase 2
 * (`resolve`) resolves defs/uses against that finished tree from any walk order.
 *
 * Identifiers with no in-function declaration (globals, fields, imports, …)
 * resolve to a SYNTHETIC module-level binding (`name@module`), created on first
 * reference and applied identically by def and use harvesting.
 *
 * NOTE: nothing serialized via the harvested bindings/facts may carry a field
 * named `nodeId` — the durable parsedfile-store reviver dedups objects keyed on
 * that field name.
 */
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { BindingEntry } from '../types.js';
import { CallSiteFactAccumulator } from './call-site-harvest.js';

/**
 * The per-statement def/use + call-site collector, aliased to the shared
 * {@link CallSiteFactAccumulator} (one name for the value and the type).
 */
export type FactAccumulator = CallSiteFactAccumulator;

export interface Scope {
  readonly parent: Scope | null;
  /** name → binding index */
  readonly table: Map<string, number>;
}

/**
 * Abstract base owning the lexical scope tree + the two-phase resolution
 * substrate. Subclasses provide the per-language constructor wiring (param /
 * receiver declaration + the body `prescan` kick-off) and the abstract
 * `prescan`; Go additionally overrides `declare` / `def` / `use` for its `_`
 * blank-identifier semantics.
 */
export abstract class ScopeTreeHarvester {
  protected readonly bindings: BindingEntry[] = [];
  protected readonly scopeByNode = new Map<number, Scope>();
  protected readonly root: Scope = { parent: null, table: new Map() };
  protected readonly synthetic = new Map<string, number>();
  protected readonly fnId: number;
  /** Innermost enclosing scope per visited node id (prescan-filled) — O(scope-chain) phase-2 resolution. */
  protected readonly nearestScopeCache = new Map<number, Scope>();
  /** >0 while walking a conditionally-evaluated subexpression — defs become may-defs. */
  protected conditionalDepth = 0;
  /**
   * Call/new node id → bindings whose declaration/assignment VALUE is exactly
   * that call (#2195 U6). Registered before the value walk, consumed by the
   * language harvester's `visitCall` (mirrors the TS harvester's
   * `resultDefTargets`).
   */
  protected readonly resultDefTargets = new Map<number, number[]>();

  constructor(protected readonly fnNode: SyntaxNode) {
    this.fnId = fnNode.id;
    this.scopeByNode.set(fnNode.id, this.root);
  }

  /** The completed binding table — pass to `CfgBuilder.finish`. */
  bindingTable(): readonly BindingEntry[] {
    return this.bindings;
  }

  // ── phase 1: declaration pre-scan ────────────────────────────────────────

  protected openScope(node: SyntaxNode): Scope {
    const existing = this.scopeByNode.get(node.id);
    if (existing) return existing;
    const scope: Scope = { parent: this.nearestScopeOf(node), table: new Map() };
    this.scopeByNode.set(node.id, scope);
    return scope;
  }

  protected nearestScopeOf(node: SyntaxNode): Scope {
    for (let p = node.parent; p; p = p.parent) {
      const s = this.scopeByNode.get(p.id);
      if (s) return s;
      if (p.id === this.fnId) break;
    }
    return this.root;
  }

  protected declare(nameNode: SyntaxNode, kind: BindingEntry['kind'], scope: Scope): void {
    const name = nameNode.text;
    if (!name || scope.table.has(name)) return;
    scope.table.set(name, this.bindings.length);
    this.bindings.push({
      name,
      declLine: nameNode.startPosition.row + 1,
      declColumn: nameNode.startPosition.column,
      kind,
    });
  }

  /**
   * Phase-1 declaration pre-scan — the only genuine per-language variation (each
   * grammar has a distinct declaration-node taxonomy). Walks the function
   * subtree once, filling `nearestScopeCache` and the scope tables.
   */
  protected abstract prescan(node: SyntaxNode, scope: Scope): void;

  // ── phase 2: per-statement fact extraction ───────────────────────────────

  protected resolve(nameNode: SyntaxNode): number {
    const name = nameNode.text;
    const cached = this.nearestScopeCache.get(nameNode.id);
    let startScope: Scope | null = cached ?? null;
    if (!startScope) {
      for (let p: SyntaxNode | null = nameNode; p; p = p.parent) {
        const scope = this.scopeByNode.get(p.id) ?? this.nearestScopeCache.get(p.id);
        if (scope) {
          startScope = scope;
          break;
        }
        if (p.id === this.fnId) {
          startScope = this.root;
          break;
        }
      }
    }
    for (let s: Scope | null = startScope; s; s = s.parent) {
      const idx = s.table.get(name);
      if (idx !== undefined) return idx;
    }
    let idx = this.synthetic.get(name);
    if (idx === undefined) {
      idx = this.bindings.length;
      this.synthetic.set(name, idx);
      this.bindings.push({ name, declLine: 0, declColumn: 0, kind: 'module', synthetic: true });
    }
    return idx;
  }

  protected def(nameNode: SyntaxNode, acc: FactAccumulator): void {
    if (this.conditionalDepth > 0) acc.addMayDef(this.resolve(nameNode));
    else acc.addDef(this.resolve(nameNode));
  }

  protected use(nameNode: SyntaxNode, acc: FactAccumulator): void {
    acc.addUse(this.resolve(nameNode));
  }

  /** Run `fn` with defs demoted to may-defs (conditionally-evaluated context). */
  protected conditional(fn: () => void): void {
    this.conditionalDepth++;
    try {
      fn();
    } finally {
      this.conditionalDepth--;
    }
  }
}
