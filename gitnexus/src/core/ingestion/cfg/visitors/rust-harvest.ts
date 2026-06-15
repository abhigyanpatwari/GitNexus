/**
 * Rust def/use harvester (#2195 U7) — the Rust analogue of
 * {@link import('./typescript-harvest.js').TsHarvester} and the C-family /
 * Go / Python harvesters. Like the Python harvester it harvests NO call-site
 * `sites[]` (the call-site taint substrate is a later step): it emits only the
 * per-function binding table ({@link BindingEntry}[]) plus {@link StatementFacts}
 * (defs / uses / mayDefs) via a local {@link FactAccumulator} with no site
 * machinery, so the produced facts never carry a `sites` key.
 *
 * Runs in the parse worker next to the Rust CFG visitor. Output is the binding
 * table the {@link import('../cfg-builder.js').CfgBuilder} stamps onto the CFG,
 * plus the per-block def/use facts the reaching-defs / CDG solvers consume.
 *
 * Every node type and field literal below was grammar-validated against
 * tree-sitter-rust via the introspection probe before use (mandatory pre-step).
 * Rust shapes pre-empted (verified by a real parse):
 *  - functions: `function_item` (fields `name`/`parameters`/`return_type`/`body`;
 *    methods are `function_item` inside an `impl_item`'s `declaration_list`) and
 *    `closure_expression` (field `parameters`=`closure_parameters`, `body` is a
 *    `block` OR a bare expression).
 *  - parameters: `parameter` (field `pattern`, optional `mutable_specifier`),
 *    `self_parameter`. A `closure_parameters` lists bare `identifier`s and/or
 *    `parameter` nodes.
 *  - declarations: `let_declaration` (field `pattern`, optional `value`, optional
 *    `alternative` block for `let … else`; optional `mutable_specifier`). The
 *    `mut` keyword is irrelevant to def-ness.
 *  - patterns (each bound `identifier` leaf is a def): `identifier`,
 *    `tuple_pattern`, `slice_pattern`, `struct_pattern` (`field_pattern`s whose
 *    `name` is a `shorthand_field_identifier`, or `name: pat`), `tuple_struct_pattern`
 *    (field `type` is the variant path — NOT a binding; the inner patterns bind),
 *    `ref_pattern` / `mut_pattern` (the inner identifier binds), `captured_pattern`
 *    (`v @ subpat` — `v` binds, and the subpattern's leaves bind), `or_pattern`,
 *    `range_pattern` (binds nothing). The wildcard `_` binds nothing.
 *  - assignments: `assignment_expression` (fields `left`/`right`),
 *    `compound_assignment_expr` (fields `left`/`operator`/`right` — read+write).
 *  - loop / match binders: `for_expression` `pattern`; `match_arm` `pattern`
 *    (a `match_pattern` whose leaves bind, plus an optional `if` guard with field
 *    `condition`); `let_condition` `pattern` (`if let` / `while let`).
 *  - reads: `field_expression` (fields `value`/`field`), `call_expression`
 *    (fields `function`/`arguments`), `binary_expression` (fields
 *    `left`/`operator`/`right`), `try_expression` (`expr?`).
 *
 * TWO-PHASE, ORDER-INDEPENDENT (load-bearing — mirrors the TS / Go / C
 * harvesters): the CFG walk is NOT source-order, so resolving names against a
 * scope stack populated *during* the walk would mis-resolve. Phase 1 pre-scans
 * the whole function subtree once, declaring every bound name into ONE function
 * table; phase 2 resolves defs/uses against that finished table from any walk
 * order. Rust DOES have block scope + shadowing, but a single function table is
 * the documented v1 simplification used by the Python harvester — distinct
 * shadowing redeclarations of the same name collapse onto one binding (an
 * over-approximation that can falsely kill across a shadow, the sound direction
 * for taint: never a missed flow).
 *
 * v1 def-semantics scope:
 *   - `let PAT = …` (and `let PAT = … else { … }`) — each identifier leaf of PAT
 *     is a def; the value (and the `else` block) are walked for uses.
 *   - `assignment_expression` plain `=` — a plain-identifier lvalue is a def; a
 *     `field_expression` / index lvalue is NOT a scalar def (its root is a use).
 *   - `compound_assignment_expr` (`x += 1`) — def AND use the lvalue.
 *   - `for PAT in ITER` — the loop pattern's leaves are defs, ITER a use.
 *   - `match` arm patterns bind their leaves; `if let` / `while let` patterns bind.
 *   - parameters (incl. `mut`, typed, closure params) are `param`-kind defs.
 * EXCLUDED, deliberately (TypeScript-CFA precedent): field / index writes
 * (`obj.f = …`, `arr[i] = …`) are NOT scalar defs — their root identifiers are
 * uses only. Nested-function bodies (`closure_expression`, an inner
 * `function_item`) are opaque in BOTH directions (captured reads/writes invisible).
 *
 * MAY-DEFS: a def inside a conditionally-evaluated subexpression — the right
 * operand of `&&` / `||` short-circuit, and a match-arm guard / `if let` pattern
 * test — is a may-def (gen WITHOUT kill), so the not-taken path's prior def is
 * not falsely killed. (Rust assignment is an expression but yields `()`, so an
 * in-`&&` assignment is rare; the machinery is kept for guard / case-test parity.)
 *
 * Identifiers with no in-function declaration (module items, imported names,
 * constants, enum variants) resolve to a SYNTHETIC module-level binding
 * (`name@module`), applied identically by def and use harvesting.
 *
 * NOTE: nothing serialized here may carry a field named `nodeId` — the durable
 * parsedfile-store reviver dedups objects keyed on that field name.
 */
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { BindingEntry, StatementFacts } from '../types.js';
import { DefUseAccumulator as FactAccumulator } from './call-site-harvest.js';

/** Node types that own a nested CFG — their subtrees are opaque to harvesting. */
const NESTED_FUNCTION_TYPES = new Set(['function_item', 'closure_expression']);

/** Pattern containers whose identifier leaves are binding targets. */
const PATTERN_CONTAINER_TYPES = new Set([
  'tuple_pattern',
  'slice_pattern',
  'or_pattern',
  'reference_pattern',
]);

export class RustHarvester {
  private readonly bindings: BindingEntry[] = [];
  /** Single function-scope name → binding index (v1: no block scope). */
  private readonly table = new Map<string, number>();
  private readonly synthetic = new Map<string, number>();
  private readonly fnId: number;
  /** >0 while walking a conditionally-evaluated subexpression — defs become may-defs. */
  private conditionalDepth = 0;

  constructor(private readonly fnNode: SyntaxNode) {
    this.fnId = fnNode.id;
    this.declareParams(fnNode);
    const body = this.bodyOf(fnNode);
    if (body) this.prescan(body);
  }

  /** The completed binding table — pass to `CfgBuilder.finish`. */
  bindingTable(): readonly BindingEntry[] {
    return this.bindings;
  }

  /** The function/closure body node (a `block` for a fn, block-or-expr for a closure). */
  private bodyOf(fnNode: SyntaxNode): SyntaxNode | undefined {
    return fnNode.childForFieldName('body') ?? undefined;
  }

  // ── phase 1: declaration pre-scan ────────────────────────────────────────

  private declare(nameNode: SyntaxNode, kind: BindingEntry['kind']): void {
    const name = nameNode.text;
    if (!name || name === '_' || this.table.has(name)) return;
    this.table.set(name, this.bindings.length);
    this.bindings.push({
      name,
      declLine: nameNode.startPosition.row + 1,
      declColumn: nameNode.startPosition.column,
      kind,
    });
  }

  /** Declare every parameter binder of a fn / closure (incl. `mut`, typed). */
  private declareParams(fnNode: SyntaxNode): void {
    const params =
      fnNode.childForFieldName('parameters') ??
      fnNode.namedChildren.find((c) => c.type === 'parameters' || c.type === 'closure_parameters');
    if (!params) return;
    for (let i = 0; i < params.namedChildCount; i++) {
      const p = params.namedChild(i);
      if (!p) continue;
      if (p.type === 'parameter') {
        const pat = p.childForFieldName('pattern');
        if (pat) this.declarePattern(pat, 'param');
      } else if (p.type === 'self_parameter') {
        // `&self` / `self` — bind `self` so reads of it resolve to a real
        // binding rather than a synthetic module name.
        const id = p.namedChildren.find((c) => c.type === 'self');
        if (id) this.declare(id, 'param');
      } else if (p.type === 'identifier') {
        // Bare closure param `|x|`.
        this.declare(p, 'param');
      } else {
        // Typed closure param without the `parameter` wrapper, etc.
        this.declarePattern(p, 'param');
      }
    }
  }

  /**
   * Pre-scan the function body once, declaring every bound name. Recurses into
   * compound expressions but NOT into nested `function_item` / `closure_expression`
   * bodies (opaque).
   */
  private prescan(node: SyntaxNode): void {
    const t = node.type;
    if (NESTED_FUNCTION_TYPES.has(t) && node.id !== this.fnId) return;

    switch (t) {
      case 'let_declaration': {
        const pat = node.childForFieldName('pattern');
        if (pat) this.declarePattern(pat, 'let');
        break;
      }
      case 'for_expression': {
        const pat = node.childForFieldName('pattern');
        if (pat) this.declarePattern(pat, 'let');
        break;
      }
      case 'let_condition': {
        // `if let PAT = …` / `while let PAT = …`.
        const pat = node.childForFieldName('pattern');
        if (pat) this.declarePattern(pat, 'let');
        break;
      }
      case 'match_arm': {
        const pat = node.childForFieldName('pattern');
        if (pat) this.declarePattern(pat, 'let');
        break;
      }
      default:
        break;
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c) this.prescan(c);
    }
  }

  /**
   * Declare every identifier leaf of a binding pattern. Handles the full Rust
   * pattern taxonomy: tuple / slice / struct / tuple-struct / ref / mut /
   * captured (`@`) / or patterns. A `tuple_struct_pattern`'s `type` field is the
   * variant PATH (`Some`, `Ok`) — not a binding; only its inner patterns bind.
   * `_`, literals and range patterns bind nothing.
   */
  private declarePattern(pat: SyntaxNode, kind: BindingEntry['kind']): void {
    const t = pat.type;
    if (t === 'identifier') {
      this.declare(pat, kind);
      return;
    }
    if (t === '_') return; // standalone wildcard pattern is the `_` node
    if (t === 'match_pattern') {
      // The arm pattern wrapper — declare its (non-guard) sub-patterns. The
      // guard `if cond` is a value test, not a binder.
      const guard = pat.childForFieldName('condition');
      for (let i = 0; i < pat.namedChildCount; i++) {
        const c = pat.namedChild(i);
        if (c && c.id !== guard?.id) this.declarePattern(c, kind);
      }
      return;
    }
    if (PATTERN_CONTAINER_TYPES.has(t)) {
      for (let i = 0; i < pat.namedChildCount; i++) {
        const c = pat.namedChild(i);
        if (c) this.declarePattern(c, kind);
      }
      return;
    }
    if (t === 'tuple_struct_pattern') {
      // `Some(n)` / `Ok(v)` — the `type` field is the variant path (not a binder);
      // every other named child is an inner binding pattern.
      const typeNode = pat.childForFieldName('type');
      for (let i = 0; i < pat.namedChildCount; i++) {
        const c = pat.namedChild(i);
        if (c && c.id !== typeNode?.id) this.declarePattern(c, kind);
      }
      return;
    }
    if (t === 'struct_pattern') {
      // `Point { x, y }` — each `field_pattern` binds; shorthand `x` binds `x`,
      // `x: pat` binds `pat`'s leaves. The `type` field is the struct path.
      for (let i = 0; i < pat.namedChildCount; i++) {
        const c = pat.namedChild(i);
        if (!c) continue;
        if (c.type === 'field_pattern') {
          this.declareFieldPattern(c, kind);
        } else if (c.type === 'shorthand_field_identifier') {
          this.declare(c, kind);
        }
      }
      return;
    }
    if (t === 'ref_pattern' || t === 'mut_pattern' || t === 'reference_pattern') {
      // `ref r` / `mut m` / `&p` — unwrap to the inner pattern.
      for (let i = 0; i < pat.namedChildCount; i++) {
        const c = pat.namedChild(i);
        if (c && c.type !== 'mutable_specifier') this.declarePattern(c, kind);
      }
      return;
    }
    if (t === 'captured_pattern') {
      // `v @ subpat` — `v` binds AND the subpattern's leaves bind.
      for (let i = 0; i < pat.namedChildCount; i++) {
        const c = pat.namedChild(i);
        if (c) this.declarePattern(c, kind);
      }
      return;
    }
    // range_pattern / literal patterns / scoped paths bind nothing.
  }

  /** `field_pattern` — shorthand `x` binds `x`; `x: pat` binds `pat`'s leaves. */
  private declareFieldPattern(field: SyntaxNode, kind: BindingEntry['kind']): void {
    const name = field.childForFieldName('name');
    const pattern = field.childForFieldName('pattern');
    if (pattern) {
      this.declarePattern(pattern, kind);
      return;
    }
    if (name && name.type === 'shorthand_field_identifier') {
      this.declare(name, kind);
      return;
    }
    // Fallback: declare any identifier / shorthand leaf.
    for (let i = 0; i < field.namedChildCount; i++) {
      const c = field.namedChild(i);
      if (c?.type === 'shorthand_field_identifier' || c?.type === 'identifier')
        this.declare(c, kind);
    }
  }

  // ── phase 2: per-statement fact extraction ───────────────────────────────

  /** Def/use facts for one statement (or construct-header expression) node. */
  facts(node: SyntaxNode): StatementFacts {
    const acc = new FactAccumulator(node.startPosition.row + 1);
    this.walkValue(node, acc);
    return acc.finish();
  }

  /** Facts for an expression whose WHOLE evaluation is conditional (guards/tests). */
  factsConditional(node: SyntaxNode): StatementFacts {
    const acc = new FactAccumulator(node.startPosition.row + 1);
    this.conditional(() => this.walkValue(node, acc));
    return acc.finish();
  }

  /**
   * Facts for a `for PAT in ITER` head: the loop pattern's leaves are defs, the
   * iterated expression a use.
   */
  forHeadFacts(stmt: SyntaxNode): StatementFacts {
    const acc = new FactAccumulator(stmt.startPosition.row + 1);
    const value = stmt.childForFieldName('value');
    const pat = stmt.childForFieldName('pattern');
    if (value) this.walkValue(value, acc);
    if (pat) this.defPattern(pat, acc);
    return acc.finish();
  }

  /**
   * Facts for ONLY a `let_declaration`'s PATTERN bindings (no value walk) — used
   * when the value is a control-flow expression already harvested by the visitor,
   * so the binding defs land on a separate continuation block without
   * double-counting the value's uses.
   */
  letPatternFacts(stmt: SyntaxNode): StatementFacts {
    const acc = new FactAccumulator(stmt.startPosition.row + 1);
    const pat = stmt.childForFieldName('pattern');
    if (pat) this.defPattern(pat, acc);
    return acc.finish();
  }

  /**
   * Facts for a `let PAT = VALUE` condition (`if let` / `while let`): the value
   * is a use, the pattern's leaves are defs. When `conditional` is true the defs
   * become may-defs (a `while let` re-test may not bind on the exit iteration).
   */
  letConditionFacts(cond: SyntaxNode, conditional: boolean): StatementFacts {
    const acc = new FactAccumulator(cond.startPosition.row + 1);
    const run = (): void => {
      const value = cond.childForFieldName('value');
      const pat = cond.childForFieldName('pattern');
      if (value) this.walkValue(value, acc);
      if (pat) this.defPattern(pat, acc);
    };
    if (conditional) this.conditional(run);
    else run();
    return acc.finish();
  }

  /**
   * Facts for a `match` arm's PATTERN bindings (#2206): `Some(n) => …` binds `n`
   * from the matched subject. The bindings are MAY-defs (only the arm that
   * actually matches binds; a later arm tests only when earlier ones didn't) and
   * are attached to the dispatch block, co-located with the subject's use, so a
   * tainted subject can propagate to the arm binding. The guard is skipped by
   * {@link defPattern}'s `match_pattern` handling. `undefined` when the pattern
   * binds nothing (`_`, a literal, a unit variant).
   */
  matchArmPatternFacts(arm: SyntaxNode): StatementFacts | undefined {
    const acc = new FactAccumulator(arm.startPosition.row + 1);
    const pat = arm.childForFieldName('pattern');
    if (pat) this.conditional(() => this.defPattern(pat, acc));
    return acc.defCount() ? acc.finish() : undefined;
  }

  /** ENTRY-block facts for the parameters (defs only — incl. default-position uses). */
  paramFacts(): StatementFacts | undefined {
    const params =
      this.fnNode.childForFieldName('parameters') ??
      this.fnNode.namedChildren.find(
        (c) => c.type === 'parameters' || c.type === 'closure_parameters',
      );
    if (!params) return undefined;
    const acc = new FactAccumulator(this.fnNode.startPosition.row + 1);
    for (let i = 0; i < params.namedChildCount; i++) {
      const p = params.namedChild(i);
      if (!p) continue;
      if (p.type === 'parameter') {
        const pat = p.childForFieldName('pattern');
        if (pat) this.defPattern(pat, acc);
      } else if (p.type === 'self_parameter') {
        const id = p.namedChildren.find((c) => c.type === 'self');
        if (id) this.def(id, acc);
      } else if (p.type === 'identifier') {
        this.def(p, acc);
      } else {
        this.defPattern(p, acc);
      }
    }
    return acc.defCount() ? acc.finish() : undefined;
  }

  private resolve(nameNode: SyntaxNode): number {
    const name = nameNode.text;
    const idx = this.table.get(name);
    if (idx !== undefined) return idx;
    let syn = this.synthetic.get(name);
    if (syn === undefined) {
      syn = this.bindings.length;
      this.synthetic.set(name, syn);
      this.bindings.push({ name, declLine: 0, declColumn: 0, kind: 'module', synthetic: true });
    }
    return syn;
  }

  private def(nameNode: SyntaxNode, acc: FactAccumulator): void {
    if (nameNode.text === '_') return; // blank target defines nothing
    if (this.conditionalDepth > 0) acc.addMayDef(this.resolve(nameNode));
    else acc.addDef(this.resolve(nameNode));
  }

  private use(nameNode: SyntaxNode, acc: FactAccumulator): void {
    if (nameNode.text === '_') return;
    acc.addUse(this.resolve(nameNode));
  }

  /** Run `fn` with defs demoted to may-defs (conditionally-evaluated context). */
  private conditional(fn: () => void): void {
    this.conditionalDepth++;
    try {
      fn();
    } finally {
      this.conditionalDepth--;
    }
  }

  /**
   * Def each identifier leaf of a binding pattern (the def-position analogue of
   * {@link declarePattern}). A `tuple_struct_pattern`'s `type` field path is a
   * variant name, not a def; its inner patterns bind. A struct field shorthand
   * binds; `_` binds nothing.
   */
  private defPattern(pat: SyntaxNode, acc: FactAccumulator): void {
    const t = pat.type;
    if (t === 'identifier') {
      this.def(pat, acc);
      return;
    }
    if (t === '_') return; // standalone wildcard pattern is the `_` node
    if (t === 'match_pattern') {
      const guard = pat.childForFieldName('condition');
      for (let i = 0; i < pat.namedChildCount; i++) {
        const c = pat.namedChild(i);
        if (c && c.id !== guard?.id) this.defPattern(c, acc);
      }
      return;
    }
    if (PATTERN_CONTAINER_TYPES.has(t)) {
      for (let i = 0; i < pat.namedChildCount; i++) {
        const c = pat.namedChild(i);
        if (c) this.defPattern(c, acc);
      }
      return;
    }
    if (t === 'tuple_struct_pattern') {
      const typeNode = pat.childForFieldName('type');
      for (let i = 0; i < pat.namedChildCount; i++) {
        const c = pat.namedChild(i);
        if (c && c.id !== typeNode?.id) this.defPattern(c, acc);
      }
      return;
    }
    if (t === 'struct_pattern') {
      for (let i = 0; i < pat.namedChildCount; i++) {
        const c = pat.namedChild(i);
        if (!c) continue;
        if (c.type === 'field_pattern') this.defFieldPattern(c, acc);
        else if (c.type === 'shorthand_field_identifier') this.def(c, acc);
      }
      return;
    }
    if (t === 'ref_pattern' || t === 'mut_pattern' || t === 'reference_pattern') {
      for (let i = 0; i < pat.namedChildCount; i++) {
        const c = pat.namedChild(i);
        if (c && c.type !== 'mutable_specifier') this.defPattern(c, acc);
      }
      return;
    }
    if (t === 'captured_pattern') {
      for (let i = 0; i < pat.namedChildCount; i++) {
        const c = pat.namedChild(i);
        if (c) this.defPattern(c, acc);
      }
      return;
    }
    // range / literal / scoped path — binds nothing.
  }

  private defFieldPattern(field: SyntaxNode, acc: FactAccumulator): void {
    const name = field.childForFieldName('name');
    const pattern = field.childForFieldName('pattern');
    if (pattern) {
      this.defPattern(pattern, acc);
      return;
    }
    if (name && name.type === 'shorthand_field_identifier') {
      this.def(name, acc);
      return;
    }
    for (let i = 0; i < field.namedChildCount; i++) {
      const c = field.namedChild(i);
      if (c?.type === 'shorthand_field_identifier' || c?.type === 'identifier') this.def(c, acc);
    }
  }

  /** Value-position walk: collect uses; route def positions to the pattern handler. */
  private walkValue(node: SyntaxNode, acc: FactAccumulator): void {
    const t = node.type;
    if (NESTED_FUNCTION_TYPES.has(t) && node.id !== this.fnId) return; // opaque

    switch (t) {
      case 'identifier':
        this.use(node, acc);
        return;
      case 'let_declaration': {
        const value = node.childForFieldName('value');
        const pat = node.childForFieldName('pattern');
        const alt = node.childForFieldName('alternative'); // `let … else { … }`
        if (value) this.walkValue(value, acc);
        if (alt) this.walkValue(alt, acc);
        if (pat) this.defPattern(pat, acc);
        return;
      }
      case 'let_condition': {
        const value = node.childForFieldName('value');
        const pat = node.childForFieldName('pattern');
        if (value) this.walkValue(value, acc);
        if (pat) this.defPattern(pat, acc);
        return;
      }
      case 'assignment_expression': {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (right) this.walkValue(right, acc);
        if (left) {
          if (left.type === 'identifier') {
            this.def(left, acc);
          } else {
            // field / index lvalue (`obj.f = …`, `a[i] = …`) — root is a use only.
            this.walkValue(left, acc);
          }
        }
        return;
      }
      case 'compound_assignment_expr': {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (right) this.walkValue(right, acc);
        if (left) {
          if (left.type === 'identifier') {
            this.use(left, acc);
            this.def(left, acc);
          } else {
            this.walkValue(left, acc);
          }
        }
        return;
      }
      case 'binary_expression': {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        const op = node.childForFieldName('operator')?.text ?? '';
        if (left) this.walkValue(left, acc);
        if (right) {
          if (op === '&&' || op === '||') this.conditional(() => this.walkValue(right, acc));
          else this.walkValue(right, acc);
        }
        return;
      }
      case 'field_expression': {
        // `a.b` — value read of the chain root only; the field name is not a
        // scalar binding.
        const value = node.childForFieldName('value');
        if (value) this.walkValue(value, acc);
        return;
      }
      default:
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (c) this.walkValue(c, acc);
        }
    }
  }
}
