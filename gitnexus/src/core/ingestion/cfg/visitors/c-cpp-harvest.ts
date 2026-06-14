/**
 * C / C++ def/use harvester (#2195 U2, plan KTD2) — the C-family analogue of
 * {@link import('./typescript-harvest.js').TsHarvester}.
 *
 * Runs in the parse worker next to the C/C++ CFG visitor, extracting
 * per-statement variable definition/use facts that ride the side channel for
 * the reaching-defs / CDG solvers. Output is the per-function binding table
 * ({@link BindingEntry}[]) plus {@link StatementFacts} the visitor attaches to
 * blocks as it walks. One class serves both languages: the control-flow node
 * set is identical (grammar-introspection probe confirmed — see U2 report),
 * and the harvest's def/use node taxonomy (`declaration`/`init_declarator`/
 * `assignment_expression`/`update_expression`/`parameter_declaration`) is shared
 * too; C++-only `lambda_expression` is handled exactly like a nested function
 * (opaque), so no language naming or branching is needed.
 *
 * TWO-PHASE, ORDER-INDEPENDENT (load-bearing — mirrors the TS harvester): the
 * CFG walk is NOT source-order (`visitFor` builds the init block after the body,
 * `visitDoWhile` the condition before the body), so resolving names against a
 * scope stack populated *during* the walk would mis-resolve. Phase 1 pre-scans
 * the whole function subtree once into a completed lexical scope tree; phase 2
 * resolves defs/uses against that finished tree from any walk order.
 *
 * v1 def-semantics scope:
 *   - `declaration` → `init_declarator` (an initialized local is a def; a bare
 *     `int x;` with no initializer writes nothing at runtime — not a def, like
 *     the TS bare-`var` rule).
 *   - `assignment_expression` (plain + compound `+=` etc.), `update_expression`
 *     (`x++`/`--x`) — define and (for compound/update) also use the lvalue.
 *   - parameters (`parameter_declaration` declarator chain).
 * EXCLUDED, deliberately (TypeScript-CFA precedent): member / pointer / array
 * writes (`obj.f = …`, `*p = …`, `a[i] = …`) are NOT scalar defs — their
 * identifiers are uses only. Both directions of nested-function (C++ lambda)
 * capture are invisible (the lambda body is an opaque block in the enclosing
 * CFG, exactly as TS treats arrow/function bodies).
 *
 * MAY-DEFS: a def inside a conditionally-evaluated subexpression — the right
 * operand of `&&`/`||` (`if (a && (x = f()))`), a ternary arm, or a switch
 * case-test — is a may-def (gen without kill), so the not-taken path's prior
 * def is not falsely killed.
 *
 * Identifiers with no in-function declaration (globals, macros, params of an
 * enclosing scope) resolve to a SYNTHETIC module-level binding (`name@module`),
 * applied identically by def and use harvesting.
 *
 * RAII NOTE: C++ destructors that run at scope exit are NOT represented in the
 * tree-sitter AST (they are implicit), so this harvest cannot and does not model
 * destructor side effects — documented gap, see the visitor doc-comment.
 *
 * NOTE: nothing serialized here may carry a field named `nodeId` — the durable
 * parsedfile-store reviver dedups objects keyed on that field name.
 */
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { BindingEntry, StatementFacts } from '../types.js';

/** Node types that own a nested CFG — their subtrees are opaque to harvesting. */
const NESTED_FUNCTION_TYPES = new Set(['lambda_expression', 'function_definition']);

/**
 * Nodes that open a lexical scope for block-local declarations. A `compound_
 * statement` is one scope; the for-loops open a scope for their loop variable.
 */
const SCOPE_TYPES = new Set([
  'compound_statement',
  'for_statement',
  'for_range_loop',
  'catch_clause',
]);

/** Type-position subtrees — identifiers inside them are not value uses. */
const TYPE_CONTEXT_TYPES = new Set([
  'type_descriptor',
  'template_argument_list',
  'template_type',
  'sized_type_specifier',
  'primitive_type',
]);

interface Scope {
  readonly parent: Scope | null;
  /** name → binding index */
  readonly table: Map<string, number>;
}

export class CCppHarvester {
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

  /** The function/lambda body block (`compound_statement`). */
  private bodyOf(fnNode: SyntaxNode): SyntaxNode | undefined {
    const body = fnNode.childForFieldName('body');
    if (body) return body;
    return fnNode.namedChildren.find((c) => c.type === 'compound_statement');
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

  /** The bare identifier a declarator chain ultimately names (or undefined). */
  private declaratorName(node: SyntaxNode | null): SyntaxNode | undefined {
    let cur: SyntaxNode | null = node;
    let hops = 12;
    while (cur && hops-- > 0) {
      if (cur.type === 'identifier' || cur.type === 'field_identifier') return cur;
      // Unwrap pointer/reference/array/init/parenthesized declarator layers.
      const next =
        cur.childForFieldName('declarator') ??
        cur.namedChildren.find(
          (c) =>
            c.type === 'identifier' ||
            c.type === 'field_identifier' ||
            c.type === 'pointer_declarator' ||
            c.type === 'reference_declarator' ||
            c.type === 'array_declarator' ||
            c.type === 'parenthesized_declarator' ||
            c.type === 'init_declarator',
        );
      if (!next || next.id === cur.id) break;
      cur = next;
    }
    return undefined;
  }

  private declareParams(fnNode: SyntaxNode): void {
    // function_definition: declarator → function_declarator → parameter_list.
    // A C++ lambda routes through abstract_function_declarator.
    const declarator = fnNode.childForFieldName('declarator');
    const fnDeclarator = this.findFunctionDeclarator(declarator);
    const params = fnDeclarator?.childForFieldName('parameters');
    if (!params) return;
    for (let i = 0; i < params.namedChildCount; i++) {
      const p = params.namedChild(i);
      if (p?.type !== 'parameter_declaration') continue;
      const name = this.declaratorName(p.childForFieldName('declarator') ?? null);
      if (name) this.declare(name, 'param', this.root);
    }
  }

  private findFunctionDeclarator(node: SyntaxNode | null): SyntaxNode | undefined {
    let cur: SyntaxNode | null = node;
    let hops = 10;
    while (cur && hops-- > 0) {
      if (cur.type === 'function_declarator' || cur.type === 'abstract_function_declarator') {
        return cur;
      }
      cur = cur.childForFieldName('declarator') ?? null;
    }
    return undefined;
  }

  private prescan(node: SyntaxNode, scope: Scope): void {
    this.nearestScopeCache.set(node.id, scope);
    const t = node.type;
    if (NESTED_FUNCTION_TYPES.has(t) && node.id !== this.fnId) {
      // A nested function/lambda body is opaque — do not descend.
      return;
    }

    let childScope = scope;
    if (SCOPE_TYPES.has(t)) childScope = this.openScope(node);

    switch (t) {
      case 'declaration':
        this.declareDeclarators(node, childScope);
        break;
      case 'for_range_loop': {
        // `for (int x : xs)` — the declarator binds in the loop scope.
        const decl = node.childForFieldName('declarator');
        const name = this.declaratorName(decl ?? null);
        if (name) this.declare(name, 'var', childScope);
        break;
      }
      case 'catch_clause': {
        const params = node.childForFieldName('parameters');
        if (params) {
          for (let i = 0; i < params.namedChildCount; i++) {
            const p = params.namedChild(i);
            if (p?.type !== 'parameter_declaration') continue;
            const name = this.declaratorName(p.childForFieldName('declarator') ?? null);
            if (name) this.declare(name, 'catch', childScope);
          }
        }
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

  private declareDeclarators(declNode: SyntaxNode, scope: Scope): void {
    for (let i = 0; i < declNode.namedChildCount; i++) {
      const d = declNode.namedChild(i);
      if (!d) continue;
      if (d.type === 'init_declarator') {
        const name = this.declaratorName(d.childForFieldName('declarator') ?? null);
        if (name) this.declare(name, 'var', scope);
      } else if (
        d.type === 'identifier' ||
        d.type === 'pointer_declarator' ||
        d.type === 'array_declarator' ||
        d.type === 'reference_declarator'
      ) {
        // Uninitialized local (`int x;`) — declare the BINDING (so a later
        // assignment resolves to a real, non-synthetic binding) but the
        // declaration itself produces no def (handled in phase 2).
        const name = this.declaratorName(d);
        if (name) this.declare(name, 'var', scope);
      }
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

  /** Facts for a `for (decl : right)` range head: decl binds, right is used. */
  forRangeHeadFacts(stmt: SyntaxNode): StatementFacts {
    const acc = new FactAccumulator(stmt.startPosition.row + 1);
    const decl = stmt.childForFieldName('declarator');
    const right = stmt.childForFieldName('right');
    const name = this.declaratorName(decl ?? null);
    if (name) this.def(name, acc);
    if (right) this.walkValue(right, acc);
    return acc.finish();
  }

  /** ENTRY-block facts for the function's parameters (defs only). */
  paramFacts(): StatementFacts | undefined {
    const declarator = this.fnNode.childForFieldName('declarator');
    const fnDeclarator = this.findFunctionDeclarator(declarator);
    const params = fnDeclarator?.childForFieldName('parameters');
    if (!params) return undefined;
    const acc = new FactAccumulator(this.fnNode.startPosition.row + 1);
    for (let i = 0; i < params.namedChildCount; i++) {
      const p = params.namedChild(i);
      if (p?.type !== 'parameter_declaration') continue;
      const name = this.declaratorName(p.childForFieldName('declarator') ?? null);
      if (name) this.def(name, acc);
    }
    return acc.defCount() ? acc.finish() : undefined;
  }

  /** Def fact for a `catch (T& e)` parameter — prepend to the handler entry block. */
  catchParamFacts(catchClause: SyntaxNode): StatementFacts | undefined {
    const params = catchClause.childForFieldName('parameters');
    if (!params) return undefined;
    const acc = new FactAccumulator(catchClause.startPosition.row + 1);
    for (let i = 0; i < params.namedChildCount; i++) {
      const p = params.namedChild(i);
      if (p?.type !== 'parameter_declaration') continue;
      const name = this.declaratorName(p.childForFieldName('declarator') ?? null);
      if (name) this.def(name, acc);
    }
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

  /** Value-position walk: collect uses; route def positions to the lvalue handler. */
  private walkValue(node: SyntaxNode, acc: FactAccumulator): void {
    const t = node.type;
    if (TYPE_CONTEXT_TYPES.has(t)) return;
    if (NESTED_FUNCTION_TYPES.has(t) && node.id !== this.fnId) {
      // Opaque nested function / lambda — captured reads/writes are invisible.
      return;
    }

    switch (t) {
      case 'identifier':
      case 'field_identifier':
        this.use(node, acc);
        return;
      case 'declaration':
        for (let i = 0; i < node.namedChildCount; i++) {
          const d = node.namedChild(i);
          if (d?.type !== 'init_declarator') continue;
          const declarator = d.childForFieldName('declarator');
          const value = d.childForFieldName('value');
          const name = declarator ? this.declaratorName(declarator) : undefined;
          // Only an INITIALIZED declarator writes (`int x = e;`). A bare
          // `int x;` is not a def (it writes nothing at runtime), matching the
          // TS bare-`var` rule. Pointer/array/member declarators are not scalar
          // defs either — their inner identifiers stay uses.
          if (name && value && declarator?.type === 'identifier') this.def(name, acc);
          else if (declarator && declarator.type !== 'identifier') this.walkValue(declarator, acc);
          if (value) this.walkValue(value, acc);
        }
        return;
      case 'assignment_expression': {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        const op = node.childForFieldName('operator')?.text ?? '=';
        if (left) {
          const lv = this.unwrapLvalue(left);
          if (lv.type === 'identifier') {
            this.def(lv, acc);
            if (op !== '=') this.use(lv, acc); // compound assign reads too
          } else {
            this.walkValue(lv, acc); // member/pointer/subscript target — uses only
          }
        }
        if (right) this.walkValue(right, acc);
        return;
      }
      case 'update_expression': {
        const rawArg = node.childForFieldName('argument');
        const arg = rawArg ? this.unwrapLvalue(rawArg) : null;
        if (arg?.type === 'identifier') {
          this.def(arg, acc);
          this.use(arg, acc);
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
          if (op === '&&' || op === '||') this.conditional(() => this.walkValue(right, acc));
          else this.walkValue(right, acc);
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
      case 'field_expression': {
        // `a.b` / `a->b` — value read of the chain root only; the field name is
        // not a scalar binding. Mirrors the TS member-read use semantics.
        const arg = node.childForFieldName('argument');
        if (arg) this.walkValue(arg, acc);
        return;
      }
      default:
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (c && !TYPE_CONTEXT_TYPES.has(c.type)) this.walkValue(c, acc);
        }
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
