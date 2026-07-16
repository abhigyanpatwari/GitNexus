/**
 * Swift def/use harvester (#2195) — the Swift analogue of
 * {@link import('./typescript-harvest.js').TsHarvester} and the C-family / Go /
 * Rust / Kotlin / Python harvesters. Like the Kotlin / Go / Python / Dart
 * harvesters it harvests the per-function binding table ({@link BindingEntry}[])
 * plus {@link StatementFacts} (defs / uses / mayDefs) AND a taint
 * {@link import('../types.js').SiteRecord} per call (callee path, receiver,
 * per-arg occurrence entries, result defs, and an `at` anchor) via the shared
 * {@link CallSiteFactAccumulator} — the same site substrate the C-family / Go /
 * TS / Kotlin / Python / Dart harvesters emit.
 *
 * SWIFT CALL SHAPE (verified by a real parse — see below; structurally identical
 * to Kotlin). A call is a `call_expression` whose LAST child is a `call_suffix`
 * (holding the `value_arguments` and/or a trailing closure `lambda_literal`); the
 * callee is the preceding expression — a bare `simple_identifier` (`foo(...)`)
 * for a FREE call, or a `navigation_expression` (`obj.method` / `a?.b`, fields
 * `target`/`suffix`→`navigation_suffix`→`suffix`:`simple_identifier`) for a
 * MEMBER call. A chained call `a.b.c()` nests `navigation_expression`s; the
 * receiver is the chain ROOT binding (`self`/literal roots launder no taint —
 * no receiver). Swift has no `new` — an init call `Foo(...)` is an ordinary
 * `call_expression` with a `simple_identifier` callee, so every site is
 * `kind: 'call'` (the CALLS query re-tags an UpperCamelCase callee
 * `@reference.call.constructor`, but the harvester only needs callee + receiver
 * + `at` right — `kind` is not joined). A `value_argument` carries its value in
 * the `value` field; a labeled arg's `value_argument_label` (`name:`) is dropped,
 * so only the value occurrence is recorded (an `&inout` value walks its target
 * for the use). Trailing closures (`xs.map { … }`) are a nested `lambda_literal`
 * — opaque (in {@link NESTED_FUNCTION_TYPES}), NOT an argument occurrence.
 *
 * ANCHOR ALIGNMENT (plan KTD7 — load-bearing): a call site's `at` MUST be the
 * SAME `[line (1-based), col (0-based)]` the Swift CALLS resolution keys its
 * `atRange` on, because a downstream unit joins the two by EXACT position. The
 * Swift scope query (query.ts) anchors `@reference.call.free`,
 * `@reference.call.member`, and `@reference.call.constructor` on the WHOLE
 * `call_expression` node (the `@reference.name` simple_identifier and the
 * `@reference.receiver` are SUB-tags, excluded from the anchor by
 * `KNOWN_SUB_TAGS` + the broadest-span rule in `anchorCaptureFor`; the
 * constructor re-tag at `captures.ts` reuses the same call_expression node, and
 * `atRange: anchor.range` at scope-extractor.ts:1030). So for a free call
 * `foo(x)`, a member call `obj.method(x)`, a chained call `a.b.c(x)`, and an init
 * call `Foo(x)` alike, `at` is the start of the enclosing `call_expression` node
 * — which, for a member/chained call, starts at the RECEIVER (`obj`/`a`), exactly
 * where the CALLS anchor starts too. This is the Kotlin/Go/Python whole-call-node
 * model, NOT the Dart callee-name model. `visitCall` receives exactly the
 * `call_expression` node and records `[node.startPosition.row + 1,
 * node.startPosition.column]`.
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
import { CallSiteFactAccumulator as FactAccumulator, finalizeChain } from './call-site-harvest.js';

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
  /**
   * `call_expression` node id → binding indices its single-target result is
   * assigned to (`let x = f()` / `x = g()` ⇒ `[x]`). Populated just before the
   * value walk reaches the call (see {@link registerResultDefs}) and consumed by
   * {@link visitCall}. Mirrors the Kotlin / Go / Python harvesters' map.
   */
  private readonly resultDefTargets = new Map<number, number[]>();

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
        const values: SyntaxNode[] = [];
        for (let i = 0; i < node.childCount; i++) {
          const field = node.fieldNameForChild(i);
          const child = node.child(i);
          if (!child) continue;
          if (field === 'value' || field === 'computed_value') values.push(child);
          else if (field === 'name') names.push(child);
        }
        // Register result-defs BEFORE the value walk so the call the walk reaches
        // carries them — single-name `let x = f()` only (a destructuring or
        // multi-binder `let (a, b) = …` / `let p = 1, q = 2` attaches nothing).
        const single = this.singlePatternBinder(names);
        if (single && values.length === 1) this.registerResultDefs(values[0], [single]);
        for (const value of values) this.walkValue(value, acc);
        for (const pat of names) this.defPattern(pat, acc);
        return;
      }
      case 'assignment': {
        const target = node.childForFieldName('target');
        const result = node.childForFieldName('result');
        const op = node.childForFieldName('operator')?.text ?? '=';
        const lv = target ? this.unwrapAssignable(target) : undefined;
        const scalar = lv && lv.type === 'simple_identifier' ? lv : undefined;
        // A plain `x = <call>` attaches `resultDefs: [x]`; a compound `+=` does
        // not (the prior value flows in too).
        if (scalar && op === '=' && result) this.registerResultDefs(result, [scalar]);
        if (result) this.walkValue(result, acc);
        if (lv) {
          if (scalar) {
            this.def(scalar, acc);
            if (op !== '=') this.use(scalar, acc); // compound assign reads too
          } else {
            // `self.x = …`, `a[i] = …` — root is a use only (not a scalar def).
            this.walkValue(lv, acc);
          }
        }
        return;
      }
      case 'call_expression':
        // A Swift call (`foo(a)`, `obj.method(x)`, `a.b.c()`, `Foo(...)`). Records
        // a taint site (callee path, receiver, per-arg occurrences, result defs)
        // while reproducing the uses the old default descent recorded. Swift has
        // no `new` — every site is `kind: 'call'`.
        this.visitCall(node, acc);
        return;
      case 'navigation_expression': {
        // `a.b` value read — the chain-root identifier is a use plus at most one
        // member-read site (the innermost access); the suffix name is not a scalar
        // binding. Mirrors the Kotlin / Go value-position member-read semantics.
        this.walkChain(node, acc, false);
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

  // ── taint-site harvest ───────────────────────────────────────────────────

  /**
   * The sole `bound_identifier` binder of a single `name` pattern, or undefined
   * when there are multiple `name` patterns or the pattern is a tuple / wildcard
   * destructuring (`let (a, b) = …`). Used to gate single-target result-defs.
   */
  private singlePatternBinder(names: readonly SyntaxNode[]): SyntaxNode | undefined {
    if (names.length !== 1) return undefined;
    const pat = names[0];
    const bound = pat.childForFieldName?.('bound_identifier');
    if (bound && bound.type === 'simple_identifier' && bound.text !== '_') return bound;
    if (pat.type === 'simple_identifier' && pat.text !== '_') return pat;
    return undefined;
  }

  /**
   * When `value`'s root (after unwrapping) is a `call_expression`, remember that
   * call site should carry `resultDefs` — the binding indices of `targets`
   * (def-position identifiers). Consumed by {@link visitCall} once the value walk
   * reaches the node. Single-target only; the blank target (`_`) binds nothing.
   */
  private registerResultDefs(value: SyntaxNode, targets: readonly SyntaxNode[]): void {
    const root = this.unwrapAssignable(value);
    if (root.type !== 'call_expression') return;
    const defs: number[] = [];
    for (const target of targets) {
      if (target.type !== 'simple_identifier' || target.text === '_') continue;
      defs.push(this.resolve(target));
    }
    if (defs.length > 0) this.resultDefTargets.set(root.id, defs);
  }

  /**
   * The callee node of a `call_expression` — the first named child that is NOT
   * the trailing `call_suffix` (a bare `simple_identifier` for a free / init
   * call, or a `navigation_expression` for a member / chained call).
   */
  private calleeOf(call: SyntaxNode): SyntaxNode | undefined {
    for (let i = 0; i < call.namedChildCount; i++) {
      const c = call.namedChild(i);
      if (c && c.type !== 'call_suffix') return c;
    }
    return undefined;
  }

  /**
   * Open + populate a call site for a Swift `call_expression`. `node` IS the
   * `call_expression` — the SAME node the scope query anchors `@reference.call.*`
   * on (its `atRange`), so the resolved-id join lands by exact position (see file
   * header ANCHOR ALIGNMENT). Swift has no `new`, so every site is `kind: 'call'`.
   */
  private visitCall(node: SyntaxNode, acc: FactAccumulator): void {
    const calleeNode = this.calleeOf(node);
    const siteIdx = acc.openCallSite('call', [
      node.startPosition.row + 1,
      node.startPosition.column,
    ]);
    acc.pushFrame(siteIdx);
    if (calleeNode) {
      const callee = this.unwrapAssignable(calleeNode);
      if (callee.type === 'simple_identifier') {
        // A bare free / init call — the callee NAME is a statement-level use but
        // NOT a value occurrence in any enclosing argument.
        if (callee.text !== '_') acc.addUseWithoutOccurrence(this.resolve(callee));
        acc.setSiteCallee(siteIdx, callee.text);
      } else if (callee.type === 'navigation_expression') {
        // skipFinalRead: the final `.name` IS the callee, carried by the path.
        const chain = this.walkChain(callee, acc, true);
        if (chain.path !== undefined) acc.setSiteCallee(siteIdx, chain.path);
        if (chain.rootIdx !== undefined) acc.setSiteReceiver(siteIdx, chain.rootIdx);
      } else {
        // Call-rooted chains (`f()()`), parenthesized callables, `self.x`-rooted —
        // the walk still records uses and nested sites; no static callee path.
        this.walkValue(callee, acc);
      }
    }
    const resultDefs = this.resultDefTargets.get(node.id);
    if (resultDefs !== undefined) acc.setSiteResultDefs(siteIdx, resultDefs);
    const suffix = node.namedChildren.find((c) => c.type === 'call_suffix');
    if (suffix) this.walkArguments(suffix, acc);
    acc.popFrame();
  }

  /**
   * Walk a `call_suffix`'s `value_arguments`, tagging each positional / labeled
   * argument's occurrence position. A trailing closure (`lambda_literal`) is a
   * nested function body — opaque (excluded by {@link NESTED_FUNCTION_TYPES}), so
   * it is not an argument occurrence here.
   */
  private walkArguments(suffix: SyntaxNode, acc: FactAccumulator): void {
    const args = suffix.namedChildren.find((c) => c.type === 'value_arguments');
    if (!args) return;
    let pos = 0;
    for (let i = 0; i < args.namedChildCount; i++) {
      const arg = args.namedChild(i);
      if (!arg || arg.type !== 'value_argument') continue;
      acc.setFrameArg(pos);
      // A labeled arg (`name: value`) records only the VALUE occurrence — the
      // `value_argument_label` is dropped. An `&inout` value walks its `target`
      // identifier for the use. Swift has no call-site spread operator.
      const value = arg.childForFieldName('value');
      if (value) this.walkValue(value, acc);
      pos++;
    }
  }

  /**
   * `navigation_expression` chain walk shared by value position and callee
   * position. Records the chain-root identifier as a use plus at most ONE
   * member-read site — the INNERMOST access — when the root is an identifier;
   * `skipFinalRead` suppresses it when that access is the callee (carried by the
   * dotted path instead). Mirrors the Kotlin / Go / Python harvesters' walkChain.
   * A non-identifier root (`self`/literal/call) launders no static path/receiver.
   */
  private walkChain(
    node: SyntaxNode,
    acc: FactAccumulator,
    skipFinalRead: boolean,
  ): { path?: string; rootIdx?: number } {
    const accesses: string[] = [];
    let cur: SyntaxNode = this.unwrapAssignable(node);
    for (;;) {
      if (cur.type === 'navigation_expression') {
        const suffix = cur.childForFieldName('suffix');
        const name = suffix?.childForFieldName('suffix');
        accesses.unshift(name?.text ?? '');
        const operand = cur.childForFieldName('target');
        if (!operand) break;
        cur = this.unwrapAssignable(operand);
      } else {
        break;
      }
    }
    // The shared terminal: root-use record + innermost member-read + path-join.
    return finalizeChain(acc, cur, accesses, skipFinalRead, (t) => t === 'simple_identifier', {
      resolve: (n) => this.resolve(n),
      walkRoot: (n) => this.walkValue(n, acc),
    });
  }
}
