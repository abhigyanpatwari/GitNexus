/**
 * Ruby def/use harvester — the Ruby analogue of
 * {@link import('./python-harvest.js').PythonHarvester} (the closest structural
 * sibling: implicit/keyword-delimited blocks, statement-modifier forms, a
 * begin/rescue/else/ensure exception model, and `case`/`when` + `case`/`in`
 * pattern matching). Like the Python harvester, this unit emits ONLY the
 * per-function binding table ({@link BindingEntry}[]) plus {@link StatementFacts}
 * (defs / uses / mayDefs) — NO call-site `sites[]` are harvested (the taint
 * substrate is a later step), so it uses a local {@link FactAccumulator} with no
 * site machinery at all and the emitted facts carry no `sites` key.
 *
 * Runs in the parse worker next to the Ruby CFG visitor.
 *
 * Every node type and field literal below was grammar-validated against
 * tree-sitter-ruby via the introspection probe before use (mandatory pre-step).
 * Ruby shapes pre-empted (verified by a real parse):
 *  - functions: `method` / `singleton_method` (fields `name`/`parameters`/`body`;
 *    `parameters` is a `method_parameters`; `body` is a `body_statement`), and
 *    blocks `do_block` (`body` = `body_statement`) / `block` (`body` =
 *    `block_body`) / `lambda` (`body` = a `block` wrapping a `block_body`) — each
 *    has a `parameters` (`block_parameters` / `lambda_parameters`).
 *  - parameters: bare `identifier`, `optional_parameter` (fields `name`/`value`),
 *    `splat_parameter` / `hash_splat_parameter` / `block_parameter` /
 *    `keyword_parameter` (field `name`).
 *  - assignment: `assignment` (fields `left`/`right`; LHS may be `identifier`,
 *    `left_assignment_list` (multi `a, b = …`), `instance_variable` (`@x`),
 *    `class_variable` (`@@x`), `global_variable` (`$x`), `constant`),
 *    `operator_assignment` (fields `left`/`operator`/`right` — read+write).
 *  - binders: `for` (fields `pattern`/`value`=`in`/`body`), block `parameters`
 *    (`block_parameters` of identifier / optional / splat leaves), rescue
 *    `variable` (an `exception_variable` wrapping the bound `identifier`).
 *  - reads: `call` (fields `receiver`?/`method`/`arguments`), `binary` (fields
 *    `left`/`operator`/`right`), `parenthesized_statements`.
 *
 * TWO-PHASE, ORDER-INDEPENDENT (load-bearing — mirrors the Python / TS / Go
 * harvesters): the CFG walk is NOT source-order, so resolving names against a
 * scope stack populated *during* the walk would mis-resolve. Phase 1 pre-scans
 * the whole function subtree once, declaring every in-function local name; phase
 * 2 resolves defs/uses against that finished table from any walk order.
 *
 * Ruby scope model (deliberately simplified, documented): Ruby binds LOCAL
 * variables on first assignment; block parameters and block-local variables have
 * their own block scope, but — exactly as the Python harvester declares all
 * targets in a SINGLE function table (a documented over-approximation) — this
 * harvester declares every assignment / for / block-param / rescue-variable /
 * method-param target into one function-scope table. Instance/class/global
 * variables (`@x` / `@@x` / `$x`) and bare constants are NOT local variables: a
 * read or write of one is recorded as a use only (an attribute-like write — its
 * "name" is not a function-scoped scalar def), matching the TS/Python member-
 * write exclusion. A bare method call with no parens (`foo`) is indistinguishable
 * from a local read at this layer; we resolve such an identifier against the
 * local table and only mint a SYNTHETIC module binding when it is unknown (the
 * conservative direction — a real method call resolves to a `module` synthetic,
 * never a false local def).
 *
 * v1 def-semantics scope:
 *   - `assignment` plain `=` — each `identifier` target in the (possibly
 *     `left_assignment_list`) LHS is a def; an `@x`/`@@x`/`$x`/`Const` target or
 *     an index/attribute target is NOT a scalar def (root is a use only).
 *   - `operator_assignment` (`x += 1`, `x ||= y`) — def AND use the lvalue.
 *   - `for x in xs` / `for a, b in xs` — the loop target(s) are defs; `xs` a use.
 *   - block params (`|x|`, `|x, y|`, `|*rest|`) — `param`-kind defs.
 *   - `rescue ... => e` — `e` is a `catch`-kind def (matters to the taint pass).
 *   - method parameters (incl. defaults, `*splat`, `**kwsplat`, `&block`,
 *     keyword) — `param`-kind defs.
 *
 * MAY-DEFS: a def inside a conditionally-evaluated subexpression is a may-def
 * (gen WITHOUT kill), so the not-taken path's prior def is not falsely killed.
 * Ruby's conditional-def shapes: an assignment in the right operand of `&&`/`and`
 * / `||`/`or` short-circuit (`a && (x = 1)`), and a `when`/`in` case-test
 * expression / `in`-clause guard (a later case only evaluates when earlier
 * patterns did not match).
 *
 * NOTE: nothing serialized here may carry a field named `nodeId` — the durable
 * parsedfile-store reviver dedups objects keyed on that field name.
 */
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { BindingEntry, StatementFacts } from '../types.js';
import { DefUseAccumulator as FactAccumulator } from './call-site-harvest.js';

/** Node types that own a nested CFG — their subtrees are opaque to harvesting. */
const NESTED_FUNCTION_TYPES = new Set([
  'method',
  'singleton_method',
  'do_block',
  'block',
  'lambda',
]);

/** Parameter container node types (method + block + lambda). */
const PARAM_CONTAINER_TYPES = new Set([
  'method_parameters',
  'block_parameters',
  'lambda_parameters',
]);

/** Parameter leaf node types whose `name` field (or bare identifier) is the binder. */
const NAMED_PARAM_TYPES = new Set([
  'optional_parameter',
  'splat_parameter',
  'hash_splat_parameter',
  'block_parameter',
  'keyword_parameter',
]);

export class RubyHarvester {
  private readonly bindings: BindingEntry[] = [];
  /** Single function-scope name → binding index (documented over-approximation). */
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

  /** The function/block/lambda body node. */
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

  /** Declare every parameter binder (method / block / lambda). */
  private declareParams(fnNode: SyntaxNode): void {
    const params = this.paramsOf(fnNode);
    if (!params) return;
    for (let i = 0; i < params.namedChildCount; i++) {
      const p = params.namedChild(i);
      if (p) this.declareParam(p);
    }
  }

  /** The `parameters` field (or first parameter-container child) of a function node. */
  private paramsOf(fnNode: SyntaxNode): SyntaxNode | undefined {
    const field = fnNode.childForFieldName('parameters');
    if (field) return field;
    return fnNode.namedChildren.find((c) => PARAM_CONTAINER_TYPES.has(c.type));
  }

  /** Declare the binder identifier of one parameter node. */
  private declareParam(p: SyntaxNode): void {
    if (p.type === 'identifier') {
      this.declare(p, 'param');
      return;
    }
    if (NAMED_PARAM_TYPES.has(p.type)) {
      const name =
        p.childForFieldName('name') ?? p.namedChildren.find((c) => c.type === 'identifier');
      if (name) this.declare(name, 'param');
      return;
    }
    // Destructured / grouped block param — declare any identifier leaves.
    for (let i = 0; i < p.namedChildCount; i++) {
      const c = p.namedChild(i);
      if (c?.type === 'identifier') this.declare(c, 'param');
      else if (c) this.declareParam(c);
    }
  }

  /**
   * Pre-scan the function body once, declaring every in-function local name.
   * Recurses into compound statements but NOT into nested function/block/lambda
   * bodies (opaque).
   */
  private prescan(node: SyntaxNode): void {
    const t = node.type;
    if (NESTED_FUNCTION_TYPES.has(t) && node.id !== this.fnId) return;

    switch (t) {
      case 'assignment': {
        const left = node.childForFieldName('left');
        if (left) this.declareTargets(left);
        break;
      }
      case 'operator_assignment': {
        const left = node.childForFieldName('left');
        if (left) this.declareTargets(left);
        break;
      }
      case 'for': {
        const pattern = node.childForFieldName('pattern');
        if (pattern) this.declareTargets(pattern);
        break;
      }
      case 'rescue': {
        this.declareRescueVar(node);
        break;
      }
      default:
        break;
    }

    // A nested `do_block`/`block`/`lambda` body is opaque, but its OWN block
    // parameters are declared (they are not local to THIS function, yet the
    // single-table model harvests them where used) — handled by declareParam in
    // the visitor's per-block harvester instance, not here. We only recurse to
    // collect assignment/for/rescue local targets in THIS function body.
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c) this.prescan(c);
    }
  }

  /** `rescue [Exc] => e` — declare `e` (a `catch`-kind def). */
  private declareRescueVar(clause: SyntaxNode): void {
    const variable = clause.childForFieldName('variable');
    const id = variable?.namedChildren.find((c) => c.type === 'identifier') ?? variable;
    if (id?.type === 'identifier') this.declare(id, 'catch');
  }

  /** Declare identifier leaves of an assignment / loop target (skip non-local LHS). */
  private declareTargets(target: SyntaxNode): void {
    const t = target.type;
    if (t === 'identifier') {
      this.declare(target, 'let');
      return;
    }
    if (t === 'left_assignment_list') {
      for (let i = 0; i < target.namedChildCount; i++) {
        const c = target.namedChild(i);
        if (c) this.declareTargets(c);
      }
      return;
    }
    if (t === 'splat_parameter' || t === 'rest_assignment') {
      const id = target.namedChildren.find((c) => c.type === 'identifier');
      if (id) this.declare(id, 'let');
      return;
    }
    // instance/class/global var, constant, element/attribute target — not a
    // function-scoped scalar def (the root identifier is a use only).
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
   * Facts for a `for PATTERN in VALUE` head: the loop target(s) are defs, the
   * iterated expression is a use.
   */
  loopHeadFacts(forNode: SyntaxNode): StatementFacts {
    const acc = new FactAccumulator(forNode.startPosition.row + 1);
    const pattern = forNode.childForFieldName('pattern');
    const value = forNode.childForFieldName('value');
    if (value) this.walkValue(value, acc);
    if (pattern) this.defTargets(pattern, acc);
    return acc.finish();
  }

  /**
   * Def-ONLY facts for a value-position assignment (`x = if … / case …`, #2205):
   * just the LHS target(s), attached to the continuation block the branch arms
   * rejoin. The branch condition + arm-value USES are harvested onto the branch's
   * own blocks (visitIf / visitCase), so this must not re-walk the RHS.
   */
  assignmentDefFacts(stmt: SyntaxNode): StatementFacts | undefined {
    const acc = new FactAccumulator(stmt.startPosition.row + 1);
    const left = stmt.childForFieldName('left');
    if (left) this.defTargets(left, acc);
    return acc.defCount() ? acc.finish() : undefined;
  }

  /** Facts for a `rescue [Exc] => e` header: `e` is a def, the exception list a use. */
  rescueHeadFacts(clause: SyntaxNode): StatementFacts {
    const acc = new FactAccumulator(clause.startPosition.row + 1);
    const exceptions = clause.childForFieldName('exceptions');
    if (exceptions) this.walkValue(exceptions, acc);
    const variable = clause.childForFieldName('variable');
    const id = variable?.namedChildren.find((c) => c.type === 'identifier');
    if (id) this.def(id, acc);
    return acc.finish();
  }

  /** ENTRY-block facts for the parameters (defs only — incl. default-value uses). */
  paramFacts(): StatementFacts | undefined {
    const params = this.paramsOf(this.fnNode);
    if (!params) return undefined;
    const acc = new FactAccumulator(this.fnNode.startPosition.row + 1);
    for (let i = 0; i < params.namedChildCount; i++) {
      const p = params.namedChild(i);
      if (p) this.defParam(p, acc);
    }
    return acc.defCount() || acc.useCount() ? acc.finish() : undefined;
  }

  /** Def the binder of one parameter node and use any default-value expr. */
  private defParam(p: SyntaxNode, acc: FactAccumulator): void {
    if (p.type === 'identifier') {
      this.def(p, acc);
      return;
    }
    if (p.type === 'optional_parameter' || p.type === 'keyword_parameter') {
      const value = p.childForFieldName('value');
      if (value) this.walkValue(value, acc);
      const name = p.childForFieldName('name');
      if (name) this.def(name, acc);
      return;
    }
    if (NAMED_PARAM_TYPES.has(p.type)) {
      const name =
        p.childForFieldName('name') ?? p.namedChildren.find((c) => c.type === 'identifier');
      if (name) this.def(name, acc);
      return;
    }
    for (let i = 0; i < p.namedChildCount; i++) {
      const c = p.namedChild(i);
      if (c?.type === 'identifier') this.def(c, acc);
      else if (c) this.defParam(c, acc);
    }
  }

  private resolve(nameNode: SyntaxNode): number {
    const name = nameNode.text;
    const idx = this.table.get(name);
    if (idx !== undefined) return idx;
    let s = this.synthetic.get(name);
    if (s === undefined) {
      s = this.bindings.length;
      this.synthetic.set(name, s);
      this.bindings.push({ name, declLine: 0, declColumn: 0, kind: 'module', synthetic: true });
    }
    return s;
  }

  private def(nameNode: SyntaxNode, acc: FactAccumulator): void {
    if (nameNode.text === '_') return;
    if (this.conditionalDepth > 0) acc.addMayDef(this.resolve(nameNode));
    else acc.addDef(this.resolve(nameNode));
  }

  private use(nameNode: SyntaxNode, acc: FactAccumulator): void {
    if (nameNode.text === '_') return;
    // Resolve only known LOCAL names; an unknown bare identifier is a method
    // call (resolves to a `module` synthetic — never a false local).
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
   * Def each identifier leaf of an assignment / loop target; route non-local
   * targets (`@x`, index/attribute writes) to the value walk (root is a use).
   */
  private defTargets(target: SyntaxNode, acc: FactAccumulator): void {
    const t = target.type;
    if (t === 'identifier') {
      this.def(target, acc);
      return;
    }
    if (t === 'left_assignment_list') {
      for (let i = 0; i < target.namedChildCount; i++) {
        const c = target.namedChild(i);
        if (c) this.defTargets(c, acc);
      }
      return;
    }
    if (t === 'splat_parameter' || t === 'rest_assignment') {
      const id = target.namedChildren.find((c) => c.type === 'identifier');
      if (id) this.def(id, acc);
      else this.walkValue(target, acc);
      return;
    }
    // instance/class/global var, constant, element/attribute target — uses only.
    this.walkValue(target, acc);
  }

  /** Value-position walk: collect uses; route def positions to the target handler. */
  private walkValue(node: SyntaxNode, acc: FactAccumulator): void {
    const t = node.type;
    if (NESTED_FUNCTION_TYPES.has(t) && node.id !== this.fnId) return; // opaque

    switch (t) {
      case 'identifier':
        this.use(node, acc);
        return;
      // Non-local variables and constants — recorded as neither a scalar def nor
      // a local use (they are not function-scoped locals); nothing to add.
      case 'instance_variable':
      case 'class_variable':
      case 'global_variable':
      case 'constant':
      case 'self':
        return;
      case 'assignment': {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (right) this.walkValue(right, acc);
        if (left) this.defTargets(left, acc);
        return;
      }
      case 'operator_assignment': {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (right) this.walkValue(right, acc);
        if (left) {
          if (left.type === 'identifier') {
            this.use(left, acc);
            this.def(left, acc);
          } else {
            this.walkValue(left, acc); // non-local lvalue — use only
          }
        }
        return;
      }
      case 'binary': {
        // `a && b` / `a || b` / `and` / `or` — the right operand is conditionally
        // evaluated, so any def inside it is a may-def; uses are still recorded.
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        const op = node.childForFieldName('operator')?.text ?? '';
        if (left) this.walkValue(left, acc);
        if (right) {
          if (op === '&&' || op === '||' || op === 'and' || op === 'or') {
            this.conditional(() => this.walkValue(right, acc));
          } else {
            this.walkValue(right, acc);
          }
        }
        return;
      }
      case 'call': {
        // `recv.meth(args)` / `meth(args)` — the receiver root + arguments are
        // uses (the method name is not a scalar binding). A nested block child is
        // its OWN function CFG (opaque here).
        const receiver = node.childForFieldName('receiver');
        const args = node.childForFieldName('arguments');
        if (receiver) this.walkValue(receiver, acc);
        if (args) this.walkValue(args, acc);
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
