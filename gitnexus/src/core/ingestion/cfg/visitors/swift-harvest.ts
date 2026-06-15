/**
 * Swift def/use harvester (#2195) — the Swift analogue of
 * {@link import('./typescript-harvest.js').TsHarvester} and the C-family / Go /
 * Rust / Python harvesters. Like the Python / Rust harvesters it harvests NO
 * call-site `sites[]` (the call-site taint substrate is a later step): it emits
 * only the per-function binding table ({@link BindingEntry}[]) plus
 * {@link StatementFacts} (defs / uses / mayDefs) via a local
 * {@link FactAccumulator} with no site machinery, so the produced facts never
 * carry a `sites` key.
 *
 * Runs in the parse worker next to the Swift CFG visitor. Output is the binding
 * table the {@link import('../cfg-builder.js').CfgBuilder} stamps onto the CFG,
 * plus the per-block def/use facts the reaching-defs / CDG solvers consume.
 *
 * Every node type and field literal below was grammar-validated against the
 * VENDORED tree-sitter-swift via the introspection probe before use (mandatory
 * pre-step). Swift shapes pre-empted (verified by a real parse):
 *  - functions: `function_declaration` / `init_declaration` / `deinit_declaration`
 *    (field `body`=`function_body`, which wraps a `statements` node) and
 *    `lambda_literal` (a closure — its `statements` follow an optional
 *    `lambda_function_type` + `in`, NO `function_body` wrapper).
 *  - parameters: `parameter` (fields `external_name`?/`name`=`simple_identifier`,
 *    plus a type child). A closure's parameters live in `lambda_function_type` →
 *    `lambda_function_type_parameters` (bare `simple_identifier`s).
 *  - `property_declaration` — Swift's `let`/`var` binding: a `value_binding_pattern`
 *    (`mutability` = `let`/`var`), then repeated `name`=`pattern` + `value`= pairs
 *    (`let p = 1, q = 2`). A `pattern` binds via `bound_identifier`=`simple_identifier`
 *    or nests `pattern`s for tuple destructuring (`let (a, b) = pair`).
 *  - optional binding (`if let` / `while let` / `guard let`): a `value_binding_pattern`
 *    in the construct's `condition` fields, then a `bound_identifier` field and the
 *    bound value as further `condition` fields.
 *  - `for_statement` fields `item`=`pattern` / `collection` / optional `where_clause`.
 *  - `catch_block` field `error`=`pattern` (the bound error).
 *  - reads: `simple_identifier`, `navigation_expression` (`a.b` — fields
 *    `target`/`suffix`), `call_expression` (`f()` — `call_suffix`),
 *    `assignment` (fields `target`/`operator`/`result`).
 *
 * TWO-PHASE, ORDER-INDEPENDENT (load-bearing — mirrors the Rust / Go / C
 * harvesters): the CFG walk is NOT source-order (`repeat … while` builds the
 * condition after the body), so resolving names against a scope stack populated
 * *during* the walk would mis-resolve. Phase 1 pre-scans the whole function
 * subtree once, declaring every bound name into ONE function table; phase 2
 * resolves defs/uses against that finished table from any walk order. Swift DOES
 * have block scope + shadowing, but a single function table is the documented v1
 * simplification used by the Python / Rust harvesters — distinct shadowing
 * redeclarations of the same name collapse onto one binding (an over-approximation
 * that can falsely kill across a shadow, the sound direction for taint).
 *
 * v1 def-semantics scope:
 *   - `property_declaration` (`let`/`var PAT = …`) — each `simple_identifier`
 *     leaf of every `name` pattern is a def; the values are walked for uses.
 *   - `assignment` plain `=` — a plain-identifier target is a def; a
 *     `navigation_expression` / subscript target (`self.x = …`, `a[i] = …`) is
 *     NOT a scalar def (its root is a use). A compound `+=`/`-=`/… target
 *     def-AND-uses the lvalue.
 *   - `for x in xs` — the loop pattern's leaves are defs, the collection a use.
 *   - optional binding (`if let` / `while let` / `guard let`) binds its pattern.
 *   - `catch_block`'s `error` pattern binds.
 *   - parameters (incl. closure params) are `param`-kind defs.
 * EXCLUDED, deliberately (TypeScript-CFA precedent): member / subscript writes
 * (`obj.f = …`, `a[i] = …`) are NOT scalar defs — their root identifiers are
 * uses only. Nested-function bodies (`lambda_literal`, a nested
 * `function_declaration`) are opaque in BOTH directions (captured reads/writes
 * invisible).
 *
 * MAY-DEFS: a def inside a conditionally-evaluated subexpression — the right
 * operand of `&&` / `||` short-circuit, and a switch-case `where` guard / case
 * test — is a may-def (gen WITHOUT kill), so the not-taken path's prior def is
 * not falsely killed. A `while let` re-test binding is also a may-def (the bind
 * does not happen on the exit iteration).
 *
 * Identifiers with no in-function declaration (module/global functions, types,
 * enum cases) resolve to a SYNTHETIC module-level binding (`name@module`),
 * applied identically by def and use harvesting.
 *
 * NOTE: nothing serialized here may carry a field named `nodeId` — the durable
 * parsedfile-store reviver dedups objects keyed on that field name.
 */
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { BindingEntry, StatementFacts } from '../types.js';
import { DefUseAccumulator as FactAccumulator } from './call-site-harvest.js';

/** Node types that own a nested CFG — their subtrees are opaque to harvesting. */
const NESTED_FUNCTION_TYPES = new Set([
  'function_declaration',
  'init_declaration',
  'deinit_declaration',
  'lambda_literal',
]);

export class SwiftHarvester {
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

  /**
   * The function/closure body `statements` node. A `function_declaration` /
   * `init_declaration` / `deinit_declaration` wraps it in a `function_body`; a
   * `lambda_literal` carries the `statements` directly.
   */
  private bodyOf(fnNode: SyntaxNode): SyntaxNode | undefined {
    const fb =
      fnNode.childForFieldName('body') ??
      fnNode.namedChildren.find((c) => c.type === 'function_body');
    if (fb && fb.type === 'function_body') {
      return fb.namedChildren.find((c) => c.type === 'statements') ?? fb;
    }
    // lambda_literal — its `statements` is a direct named child.
    return fnNode.namedChildren.find((c) => c.type === 'statements');
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

  /** Declare every parameter binder of a fn / init / closure. */
  private declareParams(fnNode: SyntaxNode): void {
    for (const p of fnNode.namedChildren) {
      if (p.type === 'parameter') {
        const name = p.childForFieldName('name');
        if (name && name.type === 'simple_identifier') this.declare(name, 'param');
      }
    }
    // Closure params live in lambda_function_type → lambda_function_type_parameters.
    const lambdaType = fnNode.namedChildren.find((c) => c.type === 'lambda_function_type');
    if (lambdaType) this.declareClosureParams(lambdaType);
  }

  private declareClosureParams(lambdaType: SyntaxNode): void {
    for (const params of lambdaType.namedChildren) {
      if (params.type !== 'lambda_function_type_parameters') continue;
      for (const id of params.namedChildren) {
        if (id.type === 'simple_identifier') this.declare(id, 'param');
        else if (id.type === 'lambda_parameter') {
          const name =
            id.childForFieldName('name') ??
            id.namedChildren.find((c) => c.type === 'simple_identifier');
          if (name) this.declare(name, 'param');
        }
      }
    }
  }

  /**
   * Pre-scan the function body once, declaring every bound name. Recurses into
   * compound expressions but NOT into nested `function_declaration` /
   * `lambda_literal` bodies (opaque).
   */
  private prescan(node: SyntaxNode): void {
    const t = node.type;
    if (NESTED_FUNCTION_TYPES.has(t) && node.id !== this.fnId) return;

    switch (t) {
      case 'property_declaration':
        // `let`/`var PAT = …` — declare every `name` pattern's leaves.
        for (let i = 0; i < node.childCount; i++) {
          if (node.fieldNameForChild(i) === 'name') {
            const pat = node.child(i);
            if (pat) this.declarePattern(pat);
          }
        }
        break;
      case 'for_statement': {
        const pat = node.childForFieldName('item');
        if (pat) this.declarePattern(pat);
        break;
      }
      case 'catch_block': {
        const err = node.childForFieldName('error');
        if (err) this.declarePattern(err);
        break;
      }
      case 'switch_pattern': {
        // `case let n` / `case (let a, let b)` / `case .some(let v)` — declare
        // the value binding(s) so a body use resolves to a real local.
        const pat = node.namedChildren.find((c) => c.type === 'pattern');
        if (pat) this.declarePattern(pat);
        break;
      }
      default:
        // Optional binding (`if let` / `while let` / `guard let`): a
        // `value_binding_pattern` condition followed by a `bound_identifier`.
        if (t === 'if_statement' || t === 'while_statement' || t === 'guard_statement') {
          this.declareOptionalBindings(node);
        }
        break;
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c) this.prescan(c);
    }
  }

  /** Declare the bindings of each optional binding in a condition. */
  private declareOptionalBindings(node: SyntaxNode): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;
      // `if/guard let v = e` — a direct `bound_identifier` field.
      if (node.fieldNameForChild(i) === 'bound_identifier') {
        this.declare(child, 'let');
      } else if (child.type === 'pattern') {
        // `if/guard case PAT = e` (e.g. `case .some(let v)`): the binder is nested
        // in a `pattern` condition child, not a direct `bound_identifier`, so it
        // was missed and resolved to a synthetic global. declarePattern finds its
        // bound leaves (#2206).
        this.declarePattern(child);
      }
    }
  }

  /**
   * Declare every `simple_identifier` leaf of a binding pattern. Handles the
   * common Swift pattern shapes: a `bound_identifier` simple pattern and tuple
   * destructuring (`(a, b)`), which nests `pattern` children. `_` (the wildcard)
   * binds nothing.
   */
  private declarePattern(pat: SyntaxNode): void {
    const bound = pat.childForFieldName?.('bound_identifier');
    if (bound && bound.type === 'simple_identifier') {
      this.declare(bound, 'let');
      return;
    }
    if (pat.type === 'simple_identifier') {
      this.declare(pat, 'let');
      return;
    }
    // Tuple / nested pattern — recurse into child patterns / identifiers.
    for (let i = 0; i < pat.namedChildCount; i++) {
      const c = pat.namedChild(i);
      if (!c) continue;
      if (c.type === 'pattern') this.declarePattern(c);
      else if (c.type === 'simple_identifier') this.declare(c, 'let');
      else if (c.type === 'value_binding_pattern') continue;
      else this.declarePattern(c);
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
   * Def-ONLY facts for a value-position binding carrier (`let x = if … / switch …`,
   * #2207): just the declared name pattern's leaves, attached to the continuation
   * block the branch arms rejoin. The condition + arm-value USES are already
   * harvested onto the branch's own blocks (visitIf / visitSwitch), so this must
   * NOT re-walk the value — only the `name`-field pattern leaves are defs here.
   */
  bindingDefFacts(stmt: SyntaxNode): StatementFacts | undefined {
    const acc = new FactAccumulator(stmt.startPosition.row + 1);
    for (let i = 0; i < stmt.childCount; i++) {
      if (stmt.fieldNameForChild(i) === 'name') {
        const pat = stmt.child(i);
        if (pat) this.defPattern(pat, acc);
      }
    }
    return acc.defCount() ? acc.finish() : undefined;
  }

  /**
   * MAY-def facts for a `switch_pattern`'s value bindings (`case let n` /
   * `case .some(let v)`). The binding only takes effect when the case matches,
   * so it is a may-def on the dispatch block — propagated into the case body
   * where the bound name is read.
   */
  switchPatternFacts(switchPattern: SyntaxNode): StatementFacts {
    const acc = new FactAccumulator(switchPattern.startPosition.row + 1);
    const pat = switchPattern.namedChildren.find((c) => c.type === 'pattern');
    if (pat) this.conditional(() => this.defPattern(pat, acc));
    return acc.finish();
  }

  /**
   * Facts for a `for item in COLLECTION` head: the loop pattern's leaves are
   * defs, the iterated collection a use. The `where` guard (if any) is harvested
   * conditionally.
   */
  forHeadFacts(stmt: SyntaxNode): StatementFacts {
    const acc = new FactAccumulator(stmt.startPosition.row + 1);
    const collection = stmt.childForFieldName('collection');
    const item = stmt.childForFieldName('item');
    if (collection) this.walkValue(collection, acc);
    if (item) this.defPattern(item, acc);
    const where = stmt.namedChildren.find((c) => c.type === 'where_clause');
    if (where) this.conditional(() => this.walkValue(where, acc));
    return acc.finish();
  }

  /**
   * Facts for an `if`/`while`/`guard` condition: optional bindings bind their
   * pattern (a def — a may-def when `conditional`), and the condition expression
   * children are uses. The construct's `condition` / `bound_identifier` fields are
   * interleaved, so we walk all children and classify them.
   */
  conditionFacts(stmt: SyntaxNode, conditional: boolean): StatementFacts {
    const acc = new FactAccumulator(stmt.startPosition.row + 1);
    const run = (): void => {
      for (let i = 0; i < stmt.childCount; i++) {
        const field = stmt.fieldNameForChild(i);
        const child = stmt.child(i);
        if (!child) continue;
        if (field === 'bound_identifier') this.def(child, acc);
        else if (field === 'condition') {
          // `value_binding_pattern` (`let`) and the `=` operator carry no uses.
          if (child.type === 'value_binding_pattern') continue;
          if (!child.isNamed) continue;
          // `if/guard case PAT = e` (e.g. `case .some(let v)`): the `pattern` child
          // BINDS — its leaves are defs (a may-def when conditional), not uses, so
          // a tainted subject propagates to the binding (#2206). The matched
          // subject and any other condition child are uses.
          if (child.type === 'pattern') this.defPattern(child, acc);
          else this.walkValue(child, acc);
        }
      }
    };
    if (conditional) this.conditional(run);
    else run();
    return acc.finish();
  }

  /** ENTRY-block facts for the parameters (defs only). */
  paramFacts(): StatementFacts | undefined {
    const acc = new FactAccumulator(this.fnNode.startPosition.row + 1);
    for (const p of this.fnNode.namedChildren) {
      if (p.type === 'parameter') {
        const name = p.childForFieldName('name');
        if (name && name.type === 'simple_identifier') this.def(name, acc);
      }
    }
    const lambdaType = this.fnNode.namedChildren.find((c) => c.type === 'lambda_function_type');
    if (lambdaType) {
      for (const params of lambdaType.namedChildren) {
        if (params.type !== 'lambda_function_type_parameters') continue;
        for (const id of params.namedChildren) {
          if (id.type === 'simple_identifier') this.def(id, acc);
          else if (id.type === 'lambda_parameter') {
            const name =
              id.childForFieldName('name') ??
              id.namedChildren.find((c) => c.type === 'simple_identifier');
            if (name) this.def(name, acc);
          }
        }
      }
    }
    return acc.defCount() ? acc.finish() : undefined;
  }

  /** Def fact for a `catch let e` error pattern — prepend to the handler entry block. */
  catchErrorFacts(catchBlock: SyntaxNode): StatementFacts | undefined {
    const err = catchBlock.childForFieldName('error');
    if (!err) return undefined;
    const acc = new FactAccumulator(catchBlock.startPosition.row + 1);
    this.defPattern(err, acc);
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
   * Def each `simple_identifier` leaf of a binding pattern (the def-position
   * analogue of {@link declarePattern}). Tuple destructuring recurses; `_` binds
   * nothing.
   */
  private defPattern(pat: SyntaxNode, acc: FactAccumulator): void {
    const bound = pat.childForFieldName?.('bound_identifier');
    if (bound && bound.type === 'simple_identifier') {
      this.def(bound, acc);
      return;
    }
    if (pat.type === 'simple_identifier') {
      this.def(pat, acc);
      return;
    }
    for (let i = 0; i < pat.namedChildCount; i++) {
      const c = pat.namedChild(i);
      if (!c) continue;
      if (c.type === 'pattern') this.defPattern(c, acc);
      else if (c.type === 'simple_identifier') this.def(c, acc);
      else if (c.type === 'value_binding_pattern') continue;
      else this.defPattern(c, acc);
    }
  }

  /** Value-position walk: collect uses; route def positions to the pattern handler. */
  private walkValue(node: SyntaxNode, acc: FactAccumulator): void {
    const t = node.type;
    if (NESTED_FUNCTION_TYPES.has(t) && node.id !== this.fnId) return; // opaque

    switch (t) {
      case 'simple_identifier':
        this.use(node, acc);
        return;
      case 'property_declaration': {
        // Walk each `value` for uses, then def each `name` pattern's leaves.
        const names: SyntaxNode[] = [];
        for (let i = 0; i < node.childCount; i++) {
          const field = node.fieldNameForChild(i);
          const child = node.child(i);
          if (!child) continue;
          if (field === 'value') this.walkValue(child, acc);
          else if (field === 'name') names.push(child);
          else if (field === 'computed_value') this.walkValue(child, acc);
        }
        for (const pat of names) this.defPattern(pat, acc);
        return;
      }
      case 'assignment': {
        const target = node.childForFieldName('target');
        const result = node.childForFieldName('result');
        const op = node.childForFieldName('operator')?.text ?? '=';
        if (result) this.walkValue(result, acc);
        if (target) {
          const lv = this.unwrapAssignable(target);
          if (lv.type === 'simple_identifier') {
            this.def(lv, acc);
            if (op !== '=') this.use(lv, acc); // compound assign reads too
          } else {
            // `self.x = …`, `a[i] = …` — root is a use only (not a scalar def).
            this.walkValue(lv, acc);
          }
        }
        return;
      }
      case 'navigation_expression': {
        // `a.b` — value read of the chain root only; the suffix name is not a
        // scalar binding.
        const target = node.childForFieldName('target');
        if (target) this.walkValue(target, acc);
        return;
      }
      case 'try_expression': {
        // `try expr` / `try? expr` / `try! expr` — the wrapped expression's uses.
        const expr = node.childForFieldName('expr');
        if (expr) this.walkValue(expr, acc);
        else
          for (let i = 0; i < node.namedChildCount; i++) {
            const c = node.namedChild(i);
            if (c && c.type !== 'try_operator') this.walkValue(c, acc);
          }
        return;
      }
      case 'conjunction_expression':
      case 'disjunction_expression': {
        // `a && b` / `a || b` — the right operand is conditionally evaluated.
        const lhs = node.childForFieldName('lhs');
        const rhs = node.childForFieldName('rhs');
        if (lhs) this.walkValue(lhs, acc);
        else if (node.namedChildCount > 0) this.walkValue(node.namedChild(0)!, acc);
        if (rhs) this.conditional(() => this.walkValue(rhs, acc));
        else if (node.namedChildCount > 1) {
          this.conditional(() => this.walkValue(node.namedChild(node.namedChildCount - 1)!, acc));
        }
        return;
      }
      case 'value_binding_pattern':
      case 'type_identifier':
      case 'user_type':
        // Binding keyword / type position — no scalar value uses.
        return;
      default:
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (c) this.walkValue(c, acc);
        }
    }
  }

  /** Strip a `directly_assignable_expression` wrapper around an lvalue. */
  private unwrapAssignable(node: SyntaxNode): SyntaxNode {
    let n = node;
    let hops = 4;
    while (n.type === 'directly_assignable_expression' && hops-- > 0) {
      const inner = n.namedChild(0);
      if (!inner) break;
      n = inner;
    }
    return n;
  }
}
