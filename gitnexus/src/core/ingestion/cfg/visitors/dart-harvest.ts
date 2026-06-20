/**
 * Dart def/use harvester (#2195) — the Dart analogue of
 * {@link import('./python-harvest.js').PythonHarvester} and the C-family
 * harvesters. Like Python it harvests per-function binding tables
 * ({@link BindingEntry}[]) plus {@link StatementFacts} (defs / uses / mayDefs)
 * AND a taint {@link import('../types.js').SiteRecord} per call / `new` (callee
 * path, receiver, per-arg occurrence entries, result defs, spread marker, and an
 * `at` anchor) via the shared {@link CallSiteFactAccumulator} — the same site
 * substrate the C-family / Go / TS / Python harvesters emit.
 *
 * DART HAS NO `call_expression` NODE (verified by a real parse — see below). A
 * call is a FLAT SIBLING RUN under a container (`expression_statement`,
 * `argument`, an `initialized_variable_definition`'s `value` field,
 * `await_expression`, …): a chain HEAD (`identifier` / `this` / `super` / a
 * parenthesized expr) immediately followed by one or more `selector` siblings.
 * A `selector` whose inner is an `argument_part` is the CALL marker (the prefix
 * up to it is the callee); a `selector` whose inner is an
 * `unconditional_assignable_selector` / `conditional_assignable_selector`
 * (`.name` / `?.name`) is a member access. So `foo(a, b)` parses as
 * `identifier foo` + `selector (a, b)`; `obj.method(x)` as `identifier obj` +
 * `selector .method` + `selector (x)`; `a.b.c()` as `a` + `.b` + `.c` + `()`.
 * A `new Foo(…)` IS a single `new_expression` node (`type_identifier` +
 * `arguments`) — the only `kind: 'new'` shape. An UpperCamelCase bare call
 * `Foo(…)` is an IMPLICIT constructor by Dart convention but is structurally a
 * free call (`identifier` + `selector(argument_part)`), so it stays
 * `kind: 'call'` (matching the scope-extractor, which tags it
 * `@reference.call.constructor` on the same callee identifier — see below).
 *
 * ANCHOR ALIGNMENT (plan KTD7 — load-bearing): a call site's `at` MUST be the
 * SAME `[line (1-based), col (0-based)]` the Dart CALLS resolution keys its
 * `atRange` on, because a downstream unit joins the two by EXACT position. Dart
 * has no whole-call node, so the scope-extractor anchors the CALLS reference NOT
 * on a call expression but on the callee NAME identifier
 * (`captures.ts emitSelectorReference`):
 *   - a FREE / implicit-constructor call `foo(…)` / `Foo(…)` →
 *     `@reference.call.free` / `.constructor` anchored on the callee `identifier`
 *     (`prev`), so `at` = that identifier's start.
 *   - a MEMBER call `obj.method(…)` → `@reference.call.member` anchored on the
 *     method-name `identifier` (`nameId`, inside the `.method` selector), so
 *     `at` = the method-name identifier's start — NOT the receiver `obj`.
 * (A `new_expression` is NOT captured for CALLS by the Dart scope-resolution
 * today, so a `new` site's `at` simply finds no resolved id — graceful, never a
 * mis-join. A cascade `a..m(…)` resolves as a FREE call on its method name.)
 *
 * Runs in the parse worker next to the Dart CFG visitor. Output is the binding
 * table the {@link import('../cfg-builder.js').CfgBuilder} stamps onto the CFG,
 * plus the per-block def/use facts the reaching-defs / CDG solvers consume.
 *
 * Every node-type literal below was grammar-validated against the VENDORED
 * tree-sitter-dart via the introspection probe before use (mandatory pre-step —
 * the grammar-literal CI gate maps `dart-harvest.ts → Dart` and fails on a wrong
 * literal). Dart's grammar splits a function into SIBLING nodes — a
 * `function_signature` / `method_signature` / getter/setter signature followed by
 * a sibling `function_body` (the body, NOT a child of the signature) — so this
 * harvester takes the `function_body` (or a closure's `function_expression`) as
 * the function node and reaches the signature via the previous sibling.
 *
 * Dart shapes pre-empted (verified by a real parse):
 *  - parameters: `function_signature`/`method_signature`/`setter_signature` own a
 *    `formal_parameter_list` → `formal_parameter` (each `name:identifier`). A
 *    closure (`function_expression`) owns `parameters:formal_parameter_list`.
 *  - `local_variable_declaration` → `initialized_variable_definition`
 *    (`name:identifier` `= value`). The declaration kind keyword is `inferred_type`
 *    (`var`), `final_builtin` (`final`), a `type_identifier`/`void_type` (typed),
 *    or `late` (anon). A bare `var e;` with no initializer still binds the name.
 *  - `for_loop_parts` — C-style (`init:local_variable_declaration`,
 *    `condition:`, `update:`) OR for-in (`inferred_type`? `name:identifier` `in`
 *    `value:` — or a bare `identifier` `in` `value:` over an existing variable).
 *  - `catch_clause` → `catch_parameters` (`(e)` or `(e, st)` — both bound).
 *  - reads: `identifier`, `selector` (`.name` / `(...args)` member/call chain),
 *    `assignment_expression` (`left:assignable_expression` `operator:` `right:`),
 *    `if_null_expression` (`a ?? b`), `conditional_expression` (`c ? a : b`),
 *    logical `&&` / `||` (`logical_and_expression` / `logical_or_expression`).
 *
 * TWO-PHASE, ORDER-INDEPENDENT (load-bearing — mirrors the Kotlin / Swift / Rust
 * harvesters): the CFG walk is NOT source-order (`do … while` builds the condition
 * after the body), so resolving names against a scope stack populated *during* the
 * walk would mis-resolve. Phase 1 pre-scans the whole function subtree once,
 * declaring every bound name into ONE function table; phase 2 resolves defs/uses
 * against that finished table from any walk order. Dart DOES have block scope +
 * shadowing, but a single function table is the documented v1 simplification used
 * by the Kotlin / Swift / Python / Rust harvesters — distinct shadowing
 * redeclarations of the same name collapse onto one binding (an over-approximation
 * that can falsely kill across a shadow, the sound direction for taint).
 *
 * v1 def-semantics scope:
 *   - `initialized_variable_definition` (`var`/`final`/typed `PAT = …`) — the
 *     `name:identifier` is a def; the value is walked for uses. A bare declaration
 *     with no initializer still binds the name (Dart locals are in scope from the
 *     declaration; an uninitialized read is a compile error, so binding is safe).
 *   - `assignment_expression` plain `=` — a plain-identifier lvalue is a def; a
 *     member / subscript target (`this.x = …`, `a[i] = …`) is NOT a scalar def
 *     (its root is a use). A compound `+=`/`-=`/… target def-AND-uses the lvalue.
 *   - `postfix_expression` / `prefix_expression` update (`i++` / `--i`) def-and-use.
 *   - `for (var e in xs)` — the loop pattern name is a def, the collection a use.
 *   - `catch (e, st)` — both error binders bind.
 *   - parameters (incl. closure params) are `param`-kind defs.
 * EXCLUDED, deliberately (TypeScript-CFA precedent): member / subscript writes
 * (`obj.f = …`, `a[i] = …`) are NOT scalar defs — their root identifiers are uses
 * only. Nested-function bodies (`function_expression`) are opaque in BOTH directions.
 *
 * MAY-DEFS: a def inside a conditionally-evaluated subexpression — the right
 * operand of `&&` / `||` short-circuit, the `??` right operand, a conditional
 * (`? :`) arm, and a `switch`-expression / case-pattern test — is a may-def (gen
 * WITHOUT kill), so the not-taken path's prior def is not falsely killed.
 *
 * Identifiers with no in-function declaration (top-level functions, types,
 * fields) resolve to a SYNTHETIC module-level binding (`name@module`), applied
 * identically by def and use harvesting.
 *
 * NOTE: nothing serialized here may carry a field named `nodeId` — the durable
 * parsedfile-store reviver dedups objects keyed on that field name.
 */
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { BindingEntry, StatementFacts } from '../types.js';
import { CallSiteFactAccumulator as FactAccumulator } from './call-site-harvest.js';

/** Selector inners that are a `.name` / `?.name` member access (not a call). */
const ASSIGNABLE_SELECTOR_TYPES = new Set([
  'unconditional_assignable_selector',
  'conditional_assignable_selector',
]);

/** Node types that own a nested CFG — their subtrees are opaque to harvesting. */
const NESTED_FUNCTION_TYPES = new Set(['function_expression', 'function_body']);

const COMMENT_TYPES = new Set(['comment', 'documentation_comment']);

const FUNCTION_VALUE_TYPES = new Set(['function_expression']);

export class DartHarvester {
  private readonly bindings: BindingEntry[] = [];
  /** Single function-scope name → binding index (v1: no block scope). */
  private readonly table = new Map<string, number>();
  private readonly synthetic = new Map<string, number>();
  private readonly fnId: number;
  /** >0 while walking a conditionally-evaluated subexpression — defs become may-defs. */
  private conditionalDepth = 0;
  /**
   * Chain-head / `new_expression` node id → binding indices its single-target
   * result is assigned to (`var x = f()` / `x = g()` ⇒ `[x]`). Populated just
   * before the value walk reaches the call (see {@link registerResultDefs}) and
   * consumed by {@link visitChainCall} / {@link visitNew}. Mirrors the Python /
   * Go harvesters' `resultDefTargets`.
   */
  private readonly resultDefTargets = new Map<number, number[]>();

  /**
   * @param fnNode  The function-bearing node: a `function_body` (whose previous
   *   sibling is the signature carrying the params) or a `function_expression`
   *   (a closure, carrying its own `parameters`).
   * @param signature  The previous-sibling signature for a `function_body`, or
   *   undefined for a `function_expression` (which carries params directly).
   */
  constructor(
    private readonly fnNode: SyntaxNode,
    private readonly signature: SyntaxNode | undefined,
  ) {
    this.fnId = fnNode.id;
    this.declareParams();
    const body = this.bodyOf(fnNode);
    if (body) this.prescan(body);
  }

  /** The completed binding table — pass to `CfgBuilder.finish`. */
  bindingTable(): readonly BindingEntry[] {
    return this.bindings;
  }

  /** The body subtree to pre-scan: a `function_body`'s `block`/expr, or a closure's body. */
  private bodyOf(fnNode: SyntaxNode): SyntaxNode | undefined {
    if (fnNode.type === 'function_expression') {
      return fnNode.childForFieldName('body') ?? undefined;
    }
    // `function_body` — its child `block` or arrow expression.
    return fnNode.namedChildren.find((c) => !COMMENT_TYPES.has(c.type));
  }

  // ── parameters ────────────────────────────────────────────────────────────

  /** The `formal_parameter_list` owning this function's params. */
  private paramList(): SyntaxNode | undefined {
    if (this.fnNode.type === 'function_expression') {
      return this.fnNode.childForFieldName('parameters') ?? undefined;
    }
    if (!this.signature) return undefined;
    // A `method_signature` wraps a `function_signature` / getter / setter that
    // carries the actual `formal_parameter_list`; unwrap one level first.
    let sig = this.signature;
    if (sig.type === 'method_signature') {
      const inner = sig.namedChildren.find(
        (c) =>
          c.type === 'function_signature' ||
          c.type === 'setter_signature' ||
          c.type === 'getter_signature' ||
          c.type === 'constructor_signature' ||
          c.type === 'factory_constructor_signature',
      );
      if (inner) sig = inner;
    }
    return sig.namedChildren.find((c) => c.type === 'formal_parameter_list');
  }

  /** Every `formal_parameter`'s bound name node. */
  private paramNames(): SyntaxNode[] {
    const list = this.paramList();
    if (!list) return [];
    const names: SyntaxNode[] = [];
    for (const p of list.namedChildren) {
      if (p.type !== 'formal_parameter') continue;
      const name =
        p.childForFieldName('name') ?? p.namedChildren.find((c) => c.type === 'identifier');
      if (name) names.push(name);
    }
    return names;
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

  private declareParams(): void {
    for (const name of this.paramNames()) this.declare(name, 'param');
  }

  /**
   * Pre-scan the function body once, declaring every bound name. Recurses into
   * compound expressions but NOT into nested function/closure bodies (opaque).
   */
  private prescan(node: SyntaxNode): void {
    const t = node.type;
    if (FUNCTION_VALUE_TYPES.has(t) && node.id !== this.fnId) return;

    switch (t) {
      case 'initialized_variable_definition':
        this.declareInitializedVar(node, 'let');
        break;
      case 'for_loop_parts':
        this.declareForParts(node);
        break;
      case 'catch_parameters':
        this.declareCatchParams(node);
        break;
      default:
        break;
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c) this.prescan(c);
    }
  }

  /** Declare every name of an `initialized_variable_definition` (`var a = 1, b = 2`). */
  private declareInitializedVar(node: SyntaxNode, kind: BindingEntry['kind']): void {
    const name = node.childForFieldName('name');
    if (name) this.declare(name, kind);
    // Trailing comma-separated bindings: each `initialized_identifier` (`b = 2`)
    // names another local that the `name` field alone misses.
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c?.type !== 'initialized_identifier') continue;
      const id = c.namedChildren.find((g) => g.type === 'identifier');
      if (id) this.declare(id, kind);
    }
  }

  /**
   * Declare a `for`'s loop variable: a C-style `init:local_variable_declaration`
   * is handled by its own `initialized_variable_definition` recursion; a for-in
   * binds the `name:identifier` after the optional `inferred_type`/type. A for-in
   * over an existing variable (`for (e in xs)`) has no declaration — its bare
   * `identifier` is a use (an assignment target), not a new binding.
   */
  private declareForParts(node: SyntaxNode): void {
    // for-in declares the loop var only when a binder keyword/type precedes it.
    if (!this.isForIn(node)) return;
    if (!this.forInDeclares(node)) return;
    const name = node.childForFieldName('name');
    if (name) this.declare(name, 'let');
  }

  /** A `for_loop_parts` is for-in iff it has an `in` keyword child + a `value` field. */
  private isForIn(node: SyntaxNode): boolean {
    return node.children.some((c) => c.type === 'in');
  }

  /** A for-in declares a fresh loop var iff a binder keyword/type precedes the name. */
  private forInDeclares(node: SyntaxNode): boolean {
    return node.namedChildren.some(
      (c) =>
        c.type === 'inferred_type' ||
        c.type === 'final_builtin' ||
        c.type === 'type_identifier' ||
        c.type === 'void_type',
    );
  }

  /** Declare a `catch (e[, st])` error name(s). */
  private declareCatchParams(node: SyntaxNode): void {
    for (const id of node.namedChildren) {
      if (id.type === 'identifier') this.declare(id, 'catch');
    }
  }

  // ── phase 2: per-statement fact extraction ───────────────────────────────

  /** Def/use facts for one statement (or construct-header expression) node. */
  facts(node: SyntaxNode): StatementFacts {
    const acc = new FactAccumulator(node.startPosition.row + 1);
    this.walkValue(node, acc);
    return acc.finish();
  }

  /** Facts for an expression whose WHOLE evaluation is conditional (case tests). */
  factsConditional(node: SyntaxNode): StatementFacts {
    const acc = new FactAccumulator(node.startPosition.row + 1);
    this.conditional(() => this.walkValue(node, acc));
    return acc.finish();
  }

  /**
   * Def-ONLY facts for a value-position binding carrier (`var x = switch (…) {…}`,
   * #2207): just the declared name(s)' def, attached to the continuation block the
   * switch arms rejoin. The subject + arm-value USES are already harvested onto
   * the branch's own blocks, so this must NOT re-walk the value — only each
   * `initialized_variable_definition`'s `name` (and trailing binders) is a def.
   */
  bindingDefFacts(stmt: SyntaxNode): StatementFacts | undefined {
    const acc = new FactAccumulator(stmt.startPosition.row + 1);
    for (const def of stmt.namedChildren) {
      if (def.type !== 'initialized_variable_definition') continue;
      const name = def.childForFieldName('name');
      if (name) this.def(name, acc);
      for (let i = 0; i < def.namedChildCount; i++) {
        const c = def.namedChild(i);
        if (c?.type !== 'initialized_identifier') continue;
        const id = c.namedChildren.find((g) => g.type === 'identifier');
        if (id) this.def(id, acc);
      }
    }
    return acc.defCount() ? acc.finish() : undefined;
  }

  /**
   * Facts for a `for` head. For-in: the loop var name is a def, the collection a
   * use. C-style: the init/condition/update sub-expressions are walked for
   * defs/uses (the init `local_variable_declaration` defines, the condition reads,
   * the update def-and-uses).
   */
  forHeadFacts(parts: SyntaxNode | undefined): StatementFacts | undefined {
    const line = (parts ?? this.fnNode).startPosition.row + 1;
    const acc = new FactAccumulator(line);
    if (!parts) return undefined;
    if (this.isForIn(parts)) {
      const value = parts.childForFieldName('value');
      if (value) this.walkValue(value, acc);
      // The loop var: a fresh `for (var e in xs)` binder is a def; a
      // `for (e in xs)` over an existing var also writes it each iteration (a
      // def). Either way the `name:identifier` is a def of the loop variable.
      const name = parts.childForFieldName('name');
      if (name) this.def(name, acc);
    } else {
      // C-style: walk init / condition / update.
      const init = parts.childForFieldName('init');
      const cond = parts.childForFieldName('condition');
      const update = parts.childForFieldName('update');
      if (init) this.walkValue(init, acc);
      if (cond) this.walkValue(cond, acc);
      if (update) this.walkValue(update, acc);
    }
    return acc.finish();
  }

  /** ENTRY-block facts for the parameters (defs only). */
  paramFacts(): StatementFacts | undefined {
    const acc = new FactAccumulator(this.fnNode.startPosition.row + 1);
    for (const name of this.paramNames()) this.def(name, acc);
    return acc.defCount() ? acc.finish() : undefined;
  }

  /** Def fact(s) for a `catch (e[, st])` — prepend to the handler entry block. */
  catchParamFacts(catchParams: SyntaxNode | undefined): StatementFacts | undefined {
    if (!catchParams) return undefined;
    const acc = new FactAccumulator(catchParams.startPosition.row + 1);
    for (const id of catchParams.namedChildren) {
      if (id.type === 'identifier') this.def(id, acc);
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

  /** Value-position walk: collect uses; route def positions to the pattern handler. */
  private walkValue(node: SyntaxNode, acc: FactAccumulator): void {
    const t = node.type;
    if (FUNCTION_VALUE_TYPES.has(t) && node.id !== this.fnId) return; // opaque closure

    switch (t) {
      case 'identifier':
        this.use(node, acc);
        return;
      case 'initialized_variable_definition': {
        const name = node.childForFieldName('name');
        // The `value` field can REPEAT across a Dart postfix run (`= g` `(y)`):
        // collect every `value`-tagged child as one chain and walk them together
        // so a member/free call across the run is harvested as one site.
        const valueRun = this.fieldRun(node, 'value');
        // Register result-defs BEFORE the value walk so the call the value walk
        // reaches carries them — single identifier target only (`var x = f()`);
        // a trailing comma-separated `b = 2` declarator attaches nothing.
        if (name && valueRun.length > 0) this.registerRunResultDefs(valueRun, [name]);
        if (valueRun.length > 0) this.walkRun(valueRun, acc);
        if (name) this.def(name, acc);
        // Trailing comma-separated bindings (`var a = 1, b = 2;`): each
        // `initialized_identifier` is an `identifier` + its own value expr.
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (c?.type !== 'initialized_identifier') continue;
          const id = c.namedChildren.find((g) => g.type === 'identifier');
          const val = c.namedChildren.find((g) => g.type !== 'identifier');
          if (val) this.walkValue(val, acc);
          if (id) this.def(id, acc);
        }
        return;
      }
      case 'assignment_expression': {
        const lvalue = node.childForFieldName('left');
        const op = node.childForFieldName('operator');
        // The `right` field can REPEAT across a postfix run (`= obj` `.m` `(y)`):
        // collect every `right`-tagged child and group the run so a call across
        // it is one site.
        const rhs = this.fieldRun(node, 'right');
        const scalar = lvalue ? this.scalarAssignTarget(lvalue) : undefined;
        // A plain `x = <call>` attaches `resultDefs: [x]` (compound `+=` does not —
        // the prior value flows in too).
        if (scalar && op?.text === '=' && rhs.length > 0) {
          this.registerRunResultDefs(rhs, [scalar]);
        }
        if (rhs.length > 0) this.walkRun(rhs, acc);
        if (lvalue) {
          if (scalar) {
            this.def(scalar, acc);
            if (op && op.text !== '=') this.use(scalar, acc); // compound assign reads too
          } else {
            // `this.x = …`, `a[i] = …` — a member / subscript write is NOT a
            // scalar def; walk the lvalue so its root identifier is a use.
            this.walkValue(lvalue, acc);
          }
        }
        return;
      }
      case 'postfix_expression':
      case 'unary_expression': {
        // `i++` (`postfix_expression`) / `++i` (`unary_expression` with an
        // `increment_operator`) — the assignable operand is def-and-use. A
        // `unary_expression` with no `increment_operator` (`!x`, `-x`, `await e`)
        // is a pure read and falls through to the generic walk below.
        const isUpdate =
          t === 'postfix_expression' ||
          node.namedChildren.some((c) => c.type === 'increment_operator');
        const operand = isUpdate
          ? node.namedChildren.find((c) => c.type === 'assignable_expression')
          : undefined;
        if (operand) {
          const scalar = this.scalarAssignTarget(operand);
          if (scalar) {
            this.use(scalar, acc);
            this.def(scalar, acc);
          } else {
            // `obj.x++` / `a[i]++` — member/subscript update, not a scalar def.
            this.walkValue(operand, acc);
          }
        } else {
          for (let i = 0; i < node.namedChildCount; i++) {
            const c = node.namedChild(i);
            if (c) this.walkValue(c, acc);
          }
        }
        return;
      }
      case 'selector': {
        // FALLBACK: a `selector` reached OUTSIDE a postfix run (normal chains are
        // grouped + harvested by `walkChildren`/`walkRun`). `.name` / `(...args)`
        // — a member-access suffix name is not a scalar binding; walk the argument
        // part for uses but skip the bare property id. No site is emitted here.
        for (const c of node.namedChildren) {
          if (
            c.type === 'unconditional_assignable_selector' ||
            c.type === 'conditional_assignable_selector'
          ) {
            continue; // `.name` — property name is not a use
          }
          this.walkValue(c, acc);
        }
        return;
      }
      case 'logical_and_expression':
      case 'logical_or_expression':
        // `a && b` / `a || b` — the right operand is conditionally evaluated. The
        // operand may be a flattened postfix run (`a && g(x)` ⇒ `a`, `g`,
        // `selector`), so group runs and demote everything after the operator.
        this.walkBinaryConditional(node, acc, new Set(['&&', '||']));
        return;
      case 'if_null_expression':
        // `a ?? b` — the right operand only evaluates when the left is null.
        this.walkBinaryConditional(node, acc, new Set(['??']));
        return;
      case 'conditional_expression':
        // `c ? a : b` — the condition runs always; both arms are conditional.
        this.walkBinaryConditional(node, acc, new Set(['?', ':']));
        return;
      case 'switch_expression': {
        // `switch (x) { p1 => a, p2 => b }` (Dart 3): the subject runs always;
        // each arm (pattern + value) is conditional, so a def inside an arm value
        // (`z = 1`) is a MAY-def, not an unconditional KILL of the prior `z`
        // (#2206). Mirrors conditional_expression.
        const subject = node.childForFieldName('condition');
        if (subject) this.walkValue(subject, acc);
        for (const c of node.namedChildren) {
          if (c.type === 'switch_expression_case') {
            this.conditional(() => this.walkValue(c, acc));
          }
        }
        return;
      }
      case 'new_expression':
        // `new Foo(args)` — the only single-node call shape Dart has. Constructor
        // site (`kind: 'new'`).
        this.visitNew(node, acc);
        return;
      case 'inferred_type':
      case 'final_builtin':
      case 'type_identifier':
      case 'void_type':
        // Binding keyword / type position — no scalar value uses.
        return;
      default:
        // A container (`expression_statement`, `argument`, `await_expression`,
        // `cascade_section`'s parent, …) whose children may form Dart postfix
        // call/access RUNS (`identifier` + `selector*`). Group runs so a call is
        // harvested as one site; non-run children walk normally.
        this.walkChildren(node.namedChildren, acc);
    }
  }

  // ── Dart postfix call/access chains (#2227 follow-up) ─────────────────────

  /**
   * Walk a container's named children, coalescing each Dart postfix RUN — a
   * chain HEAD immediately followed by one or more `selector` (and/or a
   * `cascade_section`) siblings — into a single {@link walkRun} so a member /
   * free call across the run is harvested as ONE call site. A child that does
   * not start a run walks via {@link walkValue} as before.
   */
  private walkChildren(children: readonly SyntaxNode[], acc: FactAccumulator): void {
    const named = children.filter((c) => !COMMENT_TYPES.has(c.type));
    let i = 0;
    while (i < named.length) {
      const head = named[i];
      // A run continues over immediately-following `selector` / `cascade_section`
      // siblings (the postfix suffixes applied to `head`).
      let end = i + 1;
      while (end < named.length && this.isSuffix(named[end])) end++;
      if (end > i + 1) {
        this.walkRun(named.slice(i, end), acc);
      } else {
        this.walkValue(head, acc);
      }
      i = end;
    }
  }

  /** A postfix-run suffix node: a `.name`/`(args)` `selector` or a `..m()` cascade. */
  private isSuffix(node: SyntaxNode): boolean {
    return node.type === 'selector' || node.type === 'cascade_section';
  }

  /**
   * Walk a binary / ternary expression whose operands are FLATTENED across the
   * node's children (`a ?? g(x)` ⇒ children `a`, `??`, `g`, `selector`). The
   * children before the FIRST boundary operator (`boundaries`) run
   * unconditionally; everything after a boundary is conditionally evaluated (a
   * may-def context). Each segment is grouped via {@link walkChildren} so a
   * postfix call split across children (`g` + `selector`) is one site.
   */
  private walkBinaryConditional(
    node: SyntaxNode,
    acc: FactAccumulator,
    boundaries: ReadonlySet<string>,
  ): void {
    const segments: SyntaxNode[][] = [[]];
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (!c || COMMENT_TYPES.has(c.type)) continue;
      if (!c.isNamed && boundaries.has(c.text)) {
        segments.push([]);
        continue;
      }
      if (c.isNamed) segments[segments.length - 1].push(c);
    }
    // First segment unconditional; the rest are conditional arms / right operands.
    if (segments[0].length > 0) this.walkChildren(segments[0], acc);
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.length > 0) this.conditional(() => this.walkChildren(seg, acc));
    }
  }

  /**
   * Walk one postfix run `[head, suffix*]`. A lone node (no suffixes) is just a
   * value walk. A run with suffixes is a Dart call/access chain: each `selector`
   * whose inner is an `argument_part` is a call applied to the prefix; an
   * assignable `.name`/`?.name` selector is a member access; a `cascade_section`
   * with an `argument_part` is a free call on its method name.
   */
  private walkRun(run: readonly SyntaxNode[], acc: FactAccumulator): void {
    if (run.length === 1) {
      this.walkValue(run[0], acc);
      return;
    }
    const head = run[0];
    const suffixes = run.slice(1);
    const hasCascade = suffixes.some((s) => s.type === 'cascade_section');
    // A cascade target (`a..m()`) is read once; its cascade calls are FREE calls
    // on the method name (matching the scope-extractor's cascade classification).
    if (hasCascade) {
      this.walkValue(head, acc);
      for (const s of suffixes) {
        if (s.type === 'cascade_section') this.visitCascade(s, acc);
        else this.walkValue(s, acc);
      }
      return;
    }
    // Plain postfix chain: walk left→right, opening a call site at each
    // `selector(argument_part)`. The callee path / receiver come from the prefix.
    // Only the LAST call in the run receives the binding result (`var x =
    // a.b().c()` ⇒ x is `.c()`'s result, not `.b()`'s).
    const lastCallIdx = this.lastCallSelectorIndex(run);
    let chainStartUseRecorded = false;
    let rootIdx: number | undefined;
    let rootSegment: string | undefined;
    const accesses: string[] = []; // dotted member segments since the last call
    for (let i = 0; i < run.length; i++) {
      const node = run[i];
      if (node === head) {
        const resolvedHead = this.chainHead(head);
        if (resolvedHead) {
          rootIdx = this.resolve(resolvedHead);
          rootSegment = resolvedHead.text;
        } else {
          // A non-identifier head (parenthesized expr, literal) — walk it for
          // uses; it has no static root segment.
          this.walkValue(head, acc);
        }
        continue;
      }
      // node is a `selector`.
      const inner = node.namedChild(0);
      if (inner?.type === 'argument_part') {
        // Call marker — `prefix(args)`. Record the chain root use (once). For a
        // FREE call the head IS the callee NAME — a statement-level use but NOT a
        // value occurrence in any enclosing argument (`exec(escape(x))` must not
        // put `escape` into exec's arg 0). For a MEMBER call the head is the
        // RECEIVER (a real value that launders taint) — a normal occurrence use.
        if (rootIdx !== undefined && !chainStartUseRecorded) {
          if (accesses.length === 0) acc.addUseWithoutOccurrence(rootIdx);
          else acc.addUse(rootIdx);
          chainStartUseRecorded = true;
        }
        // The accesses since the last call form the callee tail; the FINAL access
        // IS the callee (carried by the path, `skipFinalRead`), but an inner
        // access is a member READ — `a.b.c()` reads `a.b` then calls `.c` (mirror
        // the Go / Python `walkChain` innermost member-read). A single access
        // (`obj.method()`) is just the callee — no read.
        if (rootIdx !== undefined && accesses.length >= 2) {
          acc.addMemberRead(rootIdx, accesses[0]);
        }
        const anchor = this.callAnchor(run, i, head);
        this.visitChainCall(node, inner, acc, {
          rootIdx,
          callee: this.calleePath(rootSegment, accesses),
          anchor,
          isMember: accesses.length > 0,
          isLastCall: i === lastCallIdx,
        });
        // After a call the result is opaque — subsequent accesses have no static
        // root (the call return value), so drop the path.
        accesses.length = 0;
        rootSegment = undefined;
        rootIdx = undefined;
        continue;
      }
      if (inner && ASSIGNABLE_SELECTOR_TYPES.has(inner.type)) {
        // `.name` / `?.name` member access — extends the dotted path. A trailing
        // access NOT followed by a call is a value-position member READ (record
        // the root use + at most one member-read site at the innermost access).
        const seg = this.selectorName(inner);
        if (seg) accesses.push(seg.text);
        const isLastAndNotCall = i === run.length - 1;
        if (isLastAndNotCall && rootIdx !== undefined) {
          if (!chainStartUseRecorded) {
            acc.addUse(rootIdx);
            chainStartUseRecorded = true;
          }
          // Innermost access is a member read (`a.b` in `a.b.c` value position).
          if (accesses.length >= 1) acc.addMemberRead(rootIdx, accesses[0]);
        }
        continue;
      }
      // An index `[i]` / other selector — walk its inner for uses.
      this.walkValue(node, acc);
    }
    // A chain that ended without any call but had a root (`a.b` as a whole value
    // read) still records its root use even when the access loop didn't (e.g. a
    // single non-call selector run reached here without a call).
    if (rootIdx !== undefined && !chainStartUseRecorded) acc.addUse(rootIdx);
  }

  /** The chain root binding node — an `identifier` head (not `this`/`super`/literal). */
  private chainHead(head: SyntaxNode): SyntaxNode | undefined {
    return head.type === 'identifier' && head.text !== '_' ? head : undefined;
  }

  /** The bound name identifier of an assignable selector inner (`.name` ⇒ `name`). */
  private selectorName(inner: SyntaxNode): SyntaxNode | undefined {
    for (let i = inner.namedChildCount - 1; i >= 0; i--) {
      const c = inner.namedChild(i);
      if (c?.type === 'identifier') return c;
    }
    return undefined;
  }

  /** Dotted callee path `root.a.b` (or undefined when the root is not an identifier). */
  private calleePath(
    rootSegment: string | undefined,
    accesses: readonly string[],
  ): string | undefined {
    if (rootSegment === undefined) return undefined;
    return [rootSegment, ...accesses].join('.');
  }

  /**
   * The `at` anchor for a call `selector` at `run[i]`, byte-aligned with the
   * Dart CALLS `atRange` (see file header): a FREE / implicit-constructor call
   * (the call selector immediately follows the chain head) anchors on the head
   * identifier; a MEMBER call anchors on the method-NAME identifier of the
   * preceding `.method` selector.
   */
  private callAnchor(run: readonly SyntaxNode[], i: number, head: SyntaxNode): [number, number] {
    const prev = run[i - 1];
    if (prev && prev.type === 'selector') {
      const inner = prev.namedChild(0);
      const nameId = inner ? this.selectorName(inner) : undefined;
      if (nameId) return [nameId.startPosition.row + 1, nameId.startPosition.column];
    }
    // Free / constructor call — anchor on the chain head (the callee identifier).
    return [head.startPosition.row + 1, head.startPosition.column];
  }

  /**
   * Open + populate a call site for a Dart postfix `prefix(args)` call. The
   * callee NAME is a statement-level use (recorded as the chain root above, or
   * here for a bare free call), NOT a value occurrence in any enclosing argument.
   */
  private visitChainCall(
    selector: SyntaxNode,
    argPart: SyntaxNode,
    acc: FactAccumulator,
    info: {
      rootIdx: number | undefined;
      callee: string | undefined;
      anchor: [number, number];
      isMember: boolean;
      isLastCall: boolean;
    },
  ): void {
    const siteIdx = acc.openCallSite('call', info.anchor);
    acc.pushFrame(siteIdx);
    if (info.callee !== undefined) acc.setSiteCallee(siteIdx, info.callee);
    // A member call (`obj.m(x)`, `a.b.c(x)`) launders taint through its receiver
    // root; a bare free call (`foo(x)`) has no receiver.
    if (info.isMember && info.rootIdx !== undefined) acc.setSiteReceiver(siteIdx, info.rootIdx);
    // Only the run's terminal call receives the binding result (its `.parent` is
    // the run's shared `initialized_variable_definition` / `assignment_expression`).
    if (info.isLastCall) {
      const resultDefs = this.resultDefTargets.get(selector.parent?.id ?? -1);
      if (resultDefs !== undefined) acc.setSiteResultDefs(siteIdx, resultDefs);
    }
    this.walkArguments(argPart, siteIdx, acc);
    acc.popFrame();
  }

  /** Index in `run` of the LAST call-marker selector (`selector(argument_part)`). */
  private lastCallSelectorIndex(run: readonly SyntaxNode[]): number {
    for (let i = run.length - 1; i >= 0; i--) {
      const n = run[i];
      if (n.type === 'selector' && n.namedChild(0)?.type === 'argument_part') return i;
    }
    return -1;
  }

  /** A single `new Foo(args)` constructor site (`kind: 'new'`). */
  private visitNew(node: SyntaxNode, acc: FactAccumulator): void {
    const typeId = node.namedChildren.find((c) => c.type === 'type_identifier');
    const argsNode = node.namedChildren.find((c) => c.type === 'arguments');
    // `new_expression` is NOT captured for CALLS by the Dart scope-resolution, so
    // this `at` finds no resolved id — anchor on the node start for consistency.
    const siteIdx = acc.openCallSite('new', [
      node.startPosition.row + 1,
      node.startPosition.column,
    ]);
    acc.pushFrame(siteIdx);
    if (typeId) acc.setSiteCallee(siteIdx, typeId.text); // the type is not a scalar binding
    const resultDefs = this.resultDefTargets.get(node.id);
    if (resultDefs !== undefined) acc.setSiteResultDefs(siteIdx, resultDefs);
    if (argsNode) this.walkArgumentsNode(argsNode, siteIdx, acc);
    acc.popFrame();
  }

  /** A cascade call `a..method(args)` — a FREE call on the method name. */
  private visitCascade(cascade: SyntaxNode, acc: FactAccumulator): void {
    const cascadeSelector = cascade.namedChildren.find((c) => c.type === 'cascade_selector');
    const argPart = cascade.namedChildren.find((c) => c.type === 'argument_part');
    // A property cascade (`..field = x`, no argument_part) is not a call — walk
    // its non-selector children for uses and stop.
    if (!argPart) {
      for (const c of cascade.namedChildren) {
        if (c.type === 'cascade_selector') continue;
        this.walkValue(c, acc);
      }
      return;
    }
    const nameId = cascadeSelector
      ? (this.selectorName(cascadeSelector) ?? cascadeSelector)
      : undefined;
    const anchor: [number, number] = nameId
      ? [nameId.startPosition.row + 1, nameId.startPosition.column]
      : [cascade.startPosition.row + 1, cascade.startPosition.column];
    const siteIdx = acc.openCallSite('call', anchor);
    acc.pushFrame(siteIdx);
    if (nameId) acc.setSiteCallee(siteIdx, nameId.text);
    this.walkArguments(argPart, siteIdx, acc);
    acc.popFrame();
  }

  /** Walk a `selector → argument_part → arguments` for per-arg occurrences. */
  private walkArguments(argPart: SyntaxNode, siteIdx: number, acc: FactAccumulator): void {
    const args = argPart.namedChildren.find((c) => c.type === 'arguments');
    if (args) this.walkArgumentsNode(args, siteIdx, acc);
  }

  /** Walk an `arguments` node, tagging each positional / named arg's occurrence position. */
  private walkArgumentsNode(args: SyntaxNode, siteIdx: number, acc: FactAccumulator): void {
    let pos = 0;
    for (let i = 0; i < args.namedChildCount; i++) {
      const arg = args.namedChild(i);
      if (!arg || COMMENT_TYPES.has(arg.type)) continue;
      if (arg.type === 'argument' || arg.type === 'named_argument') {
        acc.setFrameArg(pos);
        // The argument value may be a flattened postfix run (`escape(x)` ⇒
        // `escape` + `selector(x)`) — group via `walkChildren` so a NESTED call is
        // its own parent-linked site (the via-tagged sanitizer-interposition
        // substrate). A `named_argument` (`k: v`) records only the VALUE
        // occurrence — the `label` name (`k`) is dropped.
        const valueChildren = arg.namedChildren.filter((c) => c.type !== 'label');
        this.walkChildren(valueChildren, acc);
        pos++;
      } else {
        // A spread `...xs` argument variant, if the grammar surfaces one.
        acc.setFrameArg(pos);
        acc.setSiteSpread(siteIdx, pos);
        this.walkValue(arg, acc);
        pos++;
      }
    }
  }

  /**
   * Register result-defs for a single-target binding whose value RUN's terminal
   * call / `new` should carry `[x]`: `var x = f()` / `var x = obj.m()` /
   * `var x = new Foo()` / `x = g(y)`. Keyed so the run's call selector (whose
   * `.parent` is the run's shared parent — the `initialized_variable_definition`
   * or `assignment_expression`) AND a single `new_expression` run-node both hit.
   */
  private registerRunResultDefs(run: readonly SyntaxNode[], targets: readonly SyntaxNode[]): void {
    const defs: number[] = [];
    for (const target of targets) {
      if (target.type !== 'identifier' || target.text === '_') continue;
      defs.push(this.resolve(target));
    }
    if (defs.length === 0) return;
    // A postfix-chain run: its call selector keys on the run's shared parent.
    const parentId = run[0]?.parent?.id;
    if (parentId !== undefined) this.resultDefTargets.set(parentId, defs);
    // A single `new Foo(…)` value: `visitNew` keys on the `new_expression` itself.
    if (run.length === 1 && run[0].type === 'new_expression') {
      this.resultDefTargets.set(run[0].id, defs);
    }
  }

  /** The `field`-tagged children of `node` (a Dart postfix run flattens here). */
  private fieldRun(node: SyntaxNode, field: string): SyntaxNode[] {
    const run: SyntaxNode[] = [];
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (!c || COMMENT_TYPES.has(c.type)) continue;
      if (node.fieldNameForChild?.(i) === field) run.push(c);
    }
    return run;
  }

  /**
   * The bare `identifier` of an `assignable_expression` lvalue WHEN it is a
   * scalar target (`x = …`), or undefined when it is a member / subscript write
   * (`obj.x = …`, `a[i] = …`) — those carry a trailing
   * `unconditional_assignable_selector` / `conditional_assignable_selector` /
   * `index_selector` and are NOT scalar defs (their root identifier is a use).
   */
  private scalarAssignTarget(node: SyntaxNode): SyntaxNode | undefined {
    // Unwrap nested `assignable_expression` wrappers (defensive).
    let n = node;
    let hops = 4;
    while (n.type === 'assignable_expression' && hops-- > 0) {
      const named = n.namedChildren.filter((c) => !COMMENT_TYPES.has(c.type));
      // A single bare identifier child ⇒ scalar target; any trailing selector ⇒
      // member/subscript write (not scalar).
      if (named.length === 1 && named[0].type === 'identifier') return named[0];
      if (named.length === 1 && named[0].type === 'assignable_expression') {
        n = named[0];
        continue;
      }
      return undefined; // identifier + selector(s) — member/subscript write
    }
    return n.type === 'identifier' ? n : undefined;
  }
}
