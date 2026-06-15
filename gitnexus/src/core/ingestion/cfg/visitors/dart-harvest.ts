/**
 * Dart def/use harvester (#2195) — the Dart analogue of
 * {@link import('./kotlin-harvest.js').KotlinHarvester} and the Swift / Python /
 * Rust harvesters. Like them it harvests NO call-site `sites[]` (the call-site
 * taint substrate is a later step): it emits only the per-function binding table
 * ({@link BindingEntry}[]) plus {@link StatementFacts} (defs / uses / mayDefs) via
 * a local {@link FactAccumulator} with no site machinery, so the produced facts
 * never carry a `sites` key.
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
import { DefUseAccumulator as FactAccumulator } from './call-site-harvest.js';

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
        const value = node.childForFieldName('value');
        if (value) this.walkValue(value, acc);
        const name = node.childForFieldName('name');
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
        const value = node.childForFieldName('right');
        if (value) this.walkValue(value, acc);
        // A `right` field can repeat (an identifier + trailing selectors): walk
        // every named child after the operator that isn't the lvalue.
        for (const c of node.namedChildren) {
          if (c === lvalue) continue;
          if (c.type === 'assignable_expression') continue;
          if (c === value) continue;
          this.walkValue(c, acc);
        }
        if (lvalue) {
          const scalar = this.scalarAssignTarget(lvalue);
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
        // `.name` / `(...args)` — a member-access suffix name is not a scalar
        // binding; walk the argument part for uses but skip the bare property id.
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
      case 'logical_or_expression': {
        // `a && b` / `a || b` — the right operand is conditionally evaluated.
        const operands = node.namedChildren.filter((c) => !COMMENT_TYPES.has(c.type));
        if (operands.length > 0) this.walkValue(operands[0], acc);
        for (let i = 1; i < operands.length; i++) {
          const rhs = operands[i];
          this.conditional(() => this.walkValue(rhs, acc));
        }
        return;
      }
      case 'if_null_expression': {
        // `a ?? b` — the right operand only evaluates when the left is null.
        const operands = node.namedChildren.filter((c) => !COMMENT_TYPES.has(c.type));
        if (operands.length > 0) this.walkValue(operands[0], acc);
        for (let i = 1; i < operands.length; i++) {
          const rhs = operands[i];
          this.conditional(() => this.walkValue(rhs, acc));
        }
        return;
      }
      case 'conditional_expression': {
        // `c ? a : b` — the condition runs always; both arms are conditional.
        const operands = node.namedChildren.filter((c) => !COMMENT_TYPES.has(c.type));
        if (operands.length > 0) this.walkValue(operands[0], acc);
        for (let i = 1; i < operands.length; i++) {
          const arm = operands[i];
          this.conditional(() => this.walkValue(arm, acc));
        }
        return;
      }
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
      case 'inferred_type':
      case 'final_builtin':
      case 'type_identifier':
      case 'void_type':
        // Binding keyword / type position — no scalar value uses.
        return;
      default:
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (c) this.walkValue(c, acc);
        }
    }
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
