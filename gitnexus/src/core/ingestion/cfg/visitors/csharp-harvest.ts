/**
 * C# def/use harvester (#2195 U3, plan KTD2) — the C# analogue of
 * {@link import('./typescript-harvest.js').TsHarvester} and the closely-related
 * {@link import('./c-cpp-harvest.js').CCppHarvester}.
 *
 * Runs in the parse worker next to the C# CFG visitor, extracting per-statement
 * variable definition/use facts that ride the side channel for the reaching-defs
 * / CDG solvers. Output is the per-function binding table ({@link BindingEntry}[])
 * plus {@link StatementFacts} the visitor attaches to blocks as it walks.
 *
 * TWO-PHASE, ORDER-INDEPENDENT (load-bearing — mirrors the TS / C-C++ harvesters):
 * the CFG walk is NOT source-order (`visitFor` builds the init block after the
 * body, `visitDoWhile` the condition before the body), so resolving names against
 * a scope stack populated *during* the walk would mis-resolve. Phase 1 pre-scans
 * the whole function subtree once into a completed lexical scope tree; phase 2
 * resolves defs/uses against that finished tree from any walk order.
 *
 * v1 def-semantics scope:
 *   - `local_declaration_statement` → `variable_declaration` → `variable_declarator`
 *     (an INITIALIZED local is a def; a bare `int x;` with no initializer writes
 *     nothing at runtime — not a def, like the TS bare-`var` rule).
 *   - `assignment_expression` (plain + compound `+=` etc.), `postfix_unary_expression`
 *     / `prefix_unary_expression` (`x++` / `--x`) — define and (for compound /
 *     update) also use the lvalue.
 *   - parameters (`parameter` → `name` field), the `foreach` loop variable
 *     (`foreach_statement` field `left`), pattern bindings (`declaration_pattern`
 *     `name`, e.g. `o is string s` / `case int n:`), and catch-clause names
 *     (`catch_declaration` `name`).
 * EXCLUDED, deliberately (TypeScript-CFA precedent): member / element / pointer
 * writes (`obj.F = …`, `a[i] = …`) are NOT scalar defs — their identifiers are
 * uses only. Nested-function (lambda / local-function / anonymous-method) bodies
 * are opaque in BOTH directions (writes to and reads of captured outer variables
 * are invisible).
 *
 * MAY-DEFS: a def inside a conditionally-evaluated subexpression — the right
 * operand of `&&` / `||` / `??` (`a ?? (a = load())`), a ternary arm, or a switch
 * arm/case test — is a may-def (gen without kill), so the not-taken path's prior
 * def is not falsely killed.
 *
 * Identifiers with no in-function declaration (fields, properties, statics,
 * namespaced names) resolve to a SYNTHETIC module-level binding (`name@module`),
 * applied identically by def and use harvesting.
 *
 * NOTE: nothing serialized here may carry a field named `nodeId` — the durable
 * parsedfile-store reviver dedups objects keyed on that field name.
 */
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { BindingEntry, StatementFacts } from '../types.js';

/** Node types that own a nested CFG — their subtrees are opaque to harvesting. */
const NESTED_FUNCTION_TYPES = new Set([
  'lambda_expression',
  'anonymous_method_expression',
  'local_function_statement',
  'method_declaration',
  'constructor_declaration',
]);

/**
 * Nodes that open a lexical scope for block-local declarations. A `block` is one
 * scope; the loop constructs open a scope for their loop variable; a
 * `catch_clause` scopes its exception name; a `using_statement` scopes its
 * resource declaration; a `switch_section` scopes its pattern bindings.
 */
const SCOPE_TYPES = new Set([
  'block',
  'for_statement',
  'foreach_statement',
  'while_statement',
  'using_statement',
  'catch_clause',
  'switch_section',
  'switch_expression_arm',
]);

interface Scope {
  readonly parent: Scope | null;
  /** name → binding index */
  readonly table: Map<string, number>;
}

export class CsharpHarvester {
  private readonly bindings: BindingEntry[] = [];
  private readonly scopeByNode = new Map<number, Scope>();
  private readonly root: Scope = { parent: null, table: new Map() };
  private readonly synthetic = new Map<string, number>();
  private readonly fnId: number;
  /** Innermost enclosing scope per visited node id (prescan-filled) — O(scope-chain) phase-2 resolution. */
  private readonly nearestScopeCache = new Map<number, Scope>();
  /** >0 while walking a conditionally-evaluated subexpression — defs become may-defs. */
  private conditionalDepth = 0;

  constructor(private readonly fnNode: SyntaxNode) {
    this.fnId = fnNode.id;
    this.scopeByNode.set(fnNode.id, this.root);
    this.declareParams(fnNode);
    const body = this.bodyOf(fnNode);
    if (body) this.prescan(body, this.openScope(body));
  }

  /** The completed binding table — pass to `CfgBuilder.finish`. */
  table(): readonly BindingEntry[] {
    return this.bindings;
  }

  /** The function/lambda body node (a `block` or an expression for `=> expr`). */
  private bodyOf(fnNode: SyntaxNode): SyntaxNode | undefined {
    const body = fnNode.childForFieldName('body');
    if (body) return body;
    // Anonymous method / local function: the body is the first `block` child.
    return fnNode.namedChildren.find((c) => c.type === 'block');
  }

  // ── phase 1: declaration pre-scan ────────────────────────────────────────

  private openScope(node: SyntaxNode): Scope {
    const existing = this.scopeByNode.get(node.id);
    if (existing) return existing;
    const scope: Scope = { parent: this.nearestScopeOf(node), table: new Map() };
    this.scopeByNode.set(node.id, scope);
    return scope;
  }

  private nearestScopeOf(node: SyntaxNode): Scope {
    for (let p = node.parent; p; p = p.parent) {
      const s = this.scopeByNode.get(p.id);
      if (s) return s;
      if (p.id === this.fnId) break;
    }
    return this.root;
  }

  private declare(nameNode: SyntaxNode, kind: BindingEntry['kind'], scope: Scope): void {
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

  private declareParams(fnNode: SyntaxNode): void {
    const params =
      fnNode.childForFieldName('parameters') ??
      fnNode.namedChildren.find(
        (c) => c.type === 'parameter_list' || c.type === 'implicit_parameter',
      );
    if (!params) return;
    if (params.type === 'implicit_parameter') {
      // Single un-parenthesized lambda parameter: `x => …`.
      this.declare(params, 'param', this.root);
      return;
    }
    for (let i = 0; i < params.namedChildCount; i++) {
      const p = params.namedChild(i);
      if (p?.type !== 'parameter') continue;
      const name = p.childForFieldName('name');
      if (name) this.declare(name, 'param', this.root);
    }
  }

  private prescan(node: SyntaxNode, scope: Scope): void {
    this.nearestScopeCache.set(node.id, scope);
    const t = node.type;
    if (NESTED_FUNCTION_TYPES.has(t) && node.id !== this.fnId) {
      // A nested function / lambda body is opaque — do not descend.
      return;
    }

    let childScope = scope;
    if (SCOPE_TYPES.has(t)) childScope = this.openScope(node);

    switch (t) {
      case 'local_declaration_statement': {
        const decl = node.namedChildren.find((c) => c.type === 'variable_declaration');
        if (decl) this.declareVariableDeclaration(decl, childScope);
        break;
      }
      case 'foreach_statement': {
        // `foreach (var x in xs)` — the `left` is the loop var (identifier or a
        // `tuple_pattern` of identifiers); binds in the loop scope.
        const left = node.childForFieldName('left');
        if (left) this.declareForeachTarget(left, childScope);
        break;
      }
      case 'using_statement': {
        // `using (var f = Open())` — declaration form binds the resource.
        const decl = node.namedChildren.find((c) => c.type === 'variable_declaration');
        if (decl) this.declareVariableDeclaration(decl, childScope);
        break;
      }
      case 'catch_clause': {
        const declNode = node.namedChildren.find((c) => c.type === 'catch_declaration');
        const name = declNode?.childForFieldName('name');
        if (name) this.declare(name, 'catch', childScope);
        break;
      }
      case 'declaration_pattern': {
        // `o is string s` / `case int n:` — `s`/`n` is a fresh binding.
        const name = node.childForFieldName('name');
        if (name) this.declare(name, 'var', childScope);
        break;
      }
      default:
        break;
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c) this.prescan(c, childScope);
    }
  }

  /** Declare every `variable_declarator` name in a `variable_declaration`. */
  private declareVariableDeclaration(declNode: SyntaxNode, scope: Scope): void {
    for (let i = 0; i < declNode.namedChildCount; i++) {
      const d = declNode.namedChild(i);
      if (d?.type !== 'variable_declarator') continue;
      const name = d.childForFieldName('name');
      if (name) this.declare(name, 'var', scope);
    }
  }

  /** Declare a `foreach` target — an identifier or a `tuple_pattern`. */
  private declareForeachTarget(left: SyntaxNode, scope: Scope): void {
    if (left.type === 'identifier') {
      this.declare(left, 'var', scope);
      return;
    }
    // `var (k, v)` deconstruction — declare each identifier under the pattern.
    for (let i = 0; i < left.namedChildCount; i++) {
      const c = left.namedChild(i);
      if (c?.type === 'identifier') this.declare(c, 'var', scope);
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

  /** Facts for a `foreach (decl in right)` head: decl binds, right is used. */
  forEachHeadFacts(stmt: SyntaxNode): StatementFacts {
    const acc = new FactAccumulator(stmt.startPosition.row + 1);
    const left = stmt.childForFieldName('left');
    const right = stmt.childForFieldName('right');
    if (left) this.defForeachTarget(left, acc);
    if (right) this.walkValue(right, acc);
    return acc.finish();
  }

  /** ENTRY-block facts for the function's parameters (defs only). */
  paramFacts(): StatementFacts | undefined {
    const params =
      this.fnNode.childForFieldName('parameters') ??
      this.fnNode.namedChildren.find(
        (c) => c.type === 'parameter_list' || c.type === 'implicit_parameter',
      );
    if (!params) return undefined;
    const acc = new FactAccumulator(this.fnNode.startPosition.row + 1);
    if (params.type === 'implicit_parameter') {
      this.def(params, acc);
    } else {
      for (let i = 0; i < params.namedChildCount; i++) {
        const p = params.namedChild(i);
        if (p?.type !== 'parameter') continue;
        const name = p.childForFieldName('name');
        if (name) this.def(name, acc);
      }
    }
    return acc.defCount() ? acc.finish() : undefined;
  }

  /** Def fact for a `catch (T e)` declaration — prepend to the handler entry block. */
  catchParamFacts(catchClause: SyntaxNode): StatementFacts | undefined {
    const declNode = catchClause.namedChildren.find((c) => c.type === 'catch_declaration');
    const name = declNode?.childForFieldName('name');
    if (!name) return undefined;
    const acc = new FactAccumulator(catchClause.startPosition.row + 1);
    this.def(name, acc);
    return acc.defCount() ? acc.finish() : undefined;
  }

  private resolve(nameNode: SyntaxNode): number {
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

  private def(nameNode: SyntaxNode, acc: FactAccumulator): void {
    if (this.conditionalDepth > 0) acc.addMayDef(this.resolve(nameNode));
    else acc.addDef(this.resolve(nameNode));
  }

  private use(nameNode: SyntaxNode, acc: FactAccumulator): void {
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

  /** Strip parenthesized wrappers around an lvalue (`(x) = 1`). */
  private unwrapLvalue(node: SyntaxNode): SyntaxNode {
    let n = node;
    let hops = 8;
    while (n.type === 'parenthesized_expression' && hops-- > 0) {
      const inner = n.namedChild(0);
      if (!inner) break;
      n = inner;
    }
    return n;
  }

  /** Def a `foreach` target (identifier or tuple) in a header fact accumulator. */
  private defForeachTarget(left: SyntaxNode, acc: FactAccumulator): void {
    if (left.type === 'identifier') {
      this.def(left, acc);
      return;
    }
    for (let i = 0; i < left.namedChildCount; i++) {
      const c = left.namedChild(i);
      if (c?.type === 'identifier') this.def(c, acc);
    }
  }

  /** Value-position walk: collect uses; route def positions to the lvalue handler. */
  private walkValue(node: SyntaxNode, acc: FactAccumulator): void {
    const t = node.type;
    if (NESTED_FUNCTION_TYPES.has(t) && node.id !== this.fnId) {
      // Opaque nested function / lambda — captured reads/writes are invisible.
      return;
    }

    switch (t) {
      case 'identifier':
        this.use(node, acc);
        return;
      case 'local_declaration_statement':
      case 'variable_declaration': {
        const decl = t === 'variable_declaration' ? node : node.namedChild(0);
        if (decl && decl.type === 'variable_declaration') {
          for (let i = 0; i < decl.namedChildCount; i++) {
            const d = decl.namedChild(i);
            if (d?.type !== 'variable_declarator') continue;
            const name = d.childForFieldName('name');
            // The initializer (if any) is the LAST named child after `name`.
            const init = this.declaratorInit(d);
            if (name && init) this.def(name, acc);
            if (init) this.walkValue(init, acc);
          }
        }
        return;
      }
      case 'assignment_expression': {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        const op = node.childForFieldName('operator')?.text ?? '=';
        if (left) {
          const lv = this.unwrapLvalue(left);
          if (lv.type === 'identifier') {
            this.def(lv, acc);
            if (op !== '=') this.use(lv, acc); // compound assign reads too
          } else if (lv.type === 'tuple_expression') {
            this.defTupleTargets(lv, acc); // `(a, b) = …` deconstruction
          } else {
            this.walkValue(lv, acc); // member/element target — uses only
          }
        }
        if (right) this.walkValue(right, acc);
        return;
      }
      case 'postfix_unary_expression':
      case 'prefix_unary_expression': {
        const arg = node.namedChild(0);
        const lv = arg ? this.unwrapLvalue(arg) : null;
        // Only `++`/`--` write; `!x`/`-x`/`~x` are pure reads. The operator is an
        // anonymous child; treat as a def+use only when the operand is an
        // identifier AND the op text is an increment/decrement.
        if (lv?.type === 'identifier' && this.isIncDec(node)) {
          this.def(lv, acc);
          this.use(lv, acc);
        } else if (arg) {
          this.walkValue(arg, acc);
        }
        return;
      }
      case 'binary_expression': {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        const op = node.childForFieldName('operator')?.text ?? '';
        if (left) this.walkValue(left, acc);
        if (right) {
          if (op === '&&' || op === '||' || op === '??') {
            this.conditional(() => this.walkValue(right, acc));
          } else {
            this.walkValue(right, acc);
          }
        }
        return;
      }
      case 'conditional_expression': {
        const cond = node.childForFieldName('condition');
        const cons = node.childForFieldName('consequence');
        const alt = node.childForFieldName('alternative');
        if (cond) this.walkValue(cond, acc);
        if (cons) this.conditional(() => this.walkValue(cons, acc));
        if (alt) this.conditional(() => this.walkValue(alt, acc));
        return;
      }
      case 'member_access_expression': {
        // `a.B` — value read of the chain root only; the member name is not a
        // scalar binding. Mirrors the TS member-read use semantics.
        const expr = node.childForFieldName('expression');
        if (expr) this.walkValue(expr, acc);
        return;
      }
      default:
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (c) this.walkValue(c, acc);
        }
    }
  }

  /** The initializer value of a `variable_declarator` — the named child after `name`. */
  private declaratorInit(declarator: SyntaxNode): SyntaxNode | undefined {
    const name = declarator.childForFieldName('name');
    for (let i = 0; i < declarator.namedChildCount; i++) {
      const c = declarator.namedChild(i);
      if (c && c.id !== name?.id) return c;
    }
    return undefined;
  }

  /** Whether a unary expression is `++`/`--` (the only writing unary ops). */
  private isIncDec(node: SyntaxNode): boolean {
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c && !c.isNamed && (c.text === '++' || c.text === '--')) return true;
    }
    return false;
  }

  /** Def each identifier in a `(a, b) = …` tuple deconstruction target. */
  private defTupleTargets(tuple: SyntaxNode, acc: FactAccumulator): void {
    for (let i = 0; i < tuple.namedChildCount; i++) {
      const c = tuple.namedChild(i);
      if (!c) continue;
      // tuple_expression wraps each element in an `argument`.
      const inner = c.type === 'argument' ? c.namedChild(0) : c;
      if (inner?.type === 'identifier') this.def(inner, acc);
      else if (inner) this.walkValue(inner, acc);
    }
  }
}

/** Ordered, deduplicating def/use collector for one statement record. */
class FactAccumulator {
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

  finish(): StatementFacts {
    return {
      line: this.line,
      defs: this.defs,
      uses: this.uses,
      ...(this.mayDefs.length > 0 ? { mayDefs: this.mayDefs } : {}),
    };
  }
}
