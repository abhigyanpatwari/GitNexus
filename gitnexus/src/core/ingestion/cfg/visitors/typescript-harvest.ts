/**
 * TS/JS def/use harvester (#2082 M2 U1).
 *
 * Runs in the parse worker next to the CFG visitor, extracting per-statement
 * variable definition/use facts that ride the side channel for the
 * reaching-defs solver (`cfg/reaching-defs.ts`). Output is the per-function
 * binding table ({@link BindingEntry}[]) plus {@link StatementFacts} records
 * the visitor attaches to blocks as it walks.
 *
 * TWO-PHASE, ORDER-INDEPENDENT (load-bearing): the CFG walk is NOT source-order
 * — `visitTry` builds the finally body before the protected body, `visitFor`
 * creates the init block after walking the body, `visitDoWhile` the condition
 * before the body. Resolving names against a scope stack populated *during*
 * that walk would mis-resolve common code (`try { var v = 1; } finally
 * { use(v); }` keys the use synthetically while the def gets the real binding —
 * the def→use fact silently never forms, a taint false negative). So phase 1
 * pre-scans the whole function subtree once, collecting every declaration into
 * a completed lexical scope tree (also resolving `var` hoisting and multi-decl
 * canonicalization order-independently, eslint-scope style); phase 2 resolves
 * defs/uses against that finished tree from any walk order.
 *
 * v1 def-semantics scope (plan KTD4): var/let/const declarations, assignments
 * (plain/compound/destructuring), update expressions, function/class
 * declarations, parameters (incl. defaults/rest/destructured), catch params,
 * for-in/of heads. EXCLUDED, deliberately: property/member writes (`this.x=`,
 * `obj.p=` — TypeScript-CFA precedent), and BOTH directions of nested-function
 * capture — writes to outer variables from nested bodies AND reads of captured
 * variables inside nested bodies are invisible (nested functions are opaque
 * blocks in the enclosing CFG; callback flows like `arr.forEach(() => sink(y))`
 * register no use of `y` — closure/callback dataflow is M4 territory and the
 * M3 consumer contract must name it).
 *
 * Identifiers with no in-function declaration (implicit globals, imports,
 * variables captured from an enclosing function) resolve to a SYNTHETIC
 * module-level binding (`name@module`), applied identically by def and use
 * harvesting so `notDeclared = 1; use(notDeclared)` still forms a fact.
 *
 * NOTE: nothing serialized here may carry a field named `nodeId` — the durable
 * parsedfile-store reviver dedups objects keyed on that field name.
 */
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { BindingEntry, StatementFacts } from '../types.js';

/** Node types that own a nested CFG — their subtrees are opaque to harvesting. */
const NESTED_FUNCTION_TYPES = new Set([
  'function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'generator_function_declaration',
  'generator_function',
  'async_function_declaration',
  'async_arrow_function',
]);

/** Function-ish declaration statements whose NAME still binds in the enclosing scope. */
const FUNCTION_DECL_TYPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'async_function_declaration',
]);

/**
 * Nodes that open a lexical scope for `let`/`const`/`class`/catch bindings.
 * A `switch` BODY is deliberately ONE scope shared by all case arms (JS
 * semantics: `case 1: let x = 1; case 2: use(x)` is the same binding).
 */
const SCOPE_TYPES = new Set([
  'statement_block',
  'for_statement',
  'for_in_statement',
  'for_of_statement',
  'catch_clause',
  'switch_body',
]);

/** Type-position subtrees — identifiers inside them are not value uses. */
const TYPE_CONTEXT_TYPES = new Set([
  'type_annotation',
  'type_arguments',
  'type_parameters',
  'type_predicate_annotation',
  'asserts_annotation',
]);

interface Scope {
  readonly parent: Scope | null;
  /** name → binding index */
  readonly table: Map<string, number>;
}

export class TsHarvester {
  private readonly bindings: BindingEntry[] = [];
  /** Scope-opening node id → its scope. */
  private readonly scopeByNode = new Map<number, Scope>();
  private readonly root: Scope = { parent: null, table: new Map() };
  /** name → synthetic binding index (implicit global / import / captured). */
  private readonly synthetic = new Map<string, number>();
  private readonly fnId: number;
  /**
   * Innermost enclosing scope per visited node id, filled during the prescan
   * (which already touches every named node once). Makes phase-2 resolution
   * O(scope-chain) instead of O(AST-depth) per identifier — a deeply-chained
   * single-statement expression (generated code) otherwise turns the
   * parent-chain walk quadratic (tri-review perf finding).
   */
  private readonly nearestScopeCache = new Map<number, Scope>();
  /**
   * >0 while walking a conditionally-evaluated subexpression (short-circuit
   * right operand, ternary arm, logical-assignment target, case test). Defs
   * found there are MAY-defs — gen without kill (tri-review P1: a must-def
   * here falsely kills the prior def on the not-taken path).
   */
  private conditionalDepth = 0;

  constructor(private readonly fnNode: SyntaxNode) {
    this.fnId = fnNode.id;
    this.scopeByNode.set(fnNode.id, this.root);
    this.declareParams(fnNode);
    const body = fnNode.childForFieldName('body');
    if (body)
      this.prescan(body, body.type === 'statement_block' ? this.openScope(body) : this.root);
  }

  /** The completed binding table — pass to `CfgBuilder.finish`. */
  table(): readonly BindingEntry[] {
    return this.bindings;
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

  private declare(
    nameNode: SyntaxNode,
    kind: BindingEntry['kind'],
    scope: Scope,
    hoistToRoot: boolean,
  ): void {
    const target = hoistToRoot ? this.root : scope;
    const name = nameNode.text;
    // `var` multi-declaration (and a param + `var` of the same name) is ONE
    // binding — first declaration in source order is canonical. The dedup is
    // scoped to the single target table, so an inner `let x` shadowing a root
    // `var x` still gets its own entry in its own scope.
    if (target.table.has(name)) return;
    target.table.set(name, this.bindings.length);
    this.bindings.push({
      name,
      declLine: nameNode.startPosition.row + 1,
      declColumn: nameNode.startPosition.column,
      kind,
    });
  }

  private declareParams(fnNode: SyntaxNode): void {
    const params = fnNode.childForFieldName('parameters') ?? fnNode.childForFieldName('parameter');
    if (!params) return;
    if (params.type === 'identifier') {
      this.declare(params, 'param', this.root, true); // `x => …` single-param arrow
      return;
    }
    for (let i = 0; i < params.namedChildCount; i++) {
      const p = params.namedChild(i);
      if (!p) continue;
      // TS wraps each param (required_parameter/optional_parameter, field
      // `pattern`); plain JS puts the pattern directly in formal_parameters.
      const pattern = p.childForFieldName('pattern') ?? p;
      this.declarePattern(pattern, 'param', this.root, true);
    }
  }

  /** Declare every name bound by a (possibly destructuring) pattern. */
  private declarePattern(
    node: SyntaxNode,
    kind: BindingEntry['kind'],
    scope: Scope,
    hoistToRoot: boolean,
  ): void {
    switch (node.type) {
      case 'identifier':
      case 'shorthand_property_identifier_pattern':
        this.declare(node, kind, scope, hoistToRoot);
        return;
      case 'rest_pattern':
      case 'object_pattern':
      case 'array_pattern':
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (c) this.declarePattern(c, kind, scope, hoistToRoot);
        }
        return;
      case 'pair_pattern': {
        const value = node.childForFieldName('value');
        if (value) this.declarePattern(value, kind, scope, hoistToRoot);
        return;
      }
      case 'assignment_pattern':
      case 'object_assignment_pattern': {
        const left = node.childForFieldName('left');
        if (left) this.declarePattern(left, kind, scope, hoistToRoot);
        return;
      }
      default:
        // Type annotations / unknown wrappers — descend defensively.
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (c && !TYPE_CONTEXT_TYPES.has(c.type)) {
            this.declarePattern(c, kind, scope, hoistToRoot);
          }
        }
    }
  }

  private prescan(node: SyntaxNode, scope: Scope): void {
    this.nearestScopeCache.set(node.id, scope);
    const t = node.type;
    if (NESTED_FUNCTION_TYPES.has(t) && node.id !== this.fnId) {
      // A nested function's NAME binds in the enclosing scope; its body is opaque.
      if (FUNCTION_DECL_TYPES.has(t)) {
        const name = node.childForFieldName('name');
        if (name) this.declare(name, 'function', scope, false);
      }
      return;
    }

    let childScope = scope;
    if (SCOPE_TYPES.has(t)) childScope = this.openScope(node);

    switch (t) {
      case 'lexical_declaration': {
        const kind = node.child(0)?.type === 'const' ? 'const' : 'let';
        this.declareDeclarators(node, kind, childScope, false);
        break;
      }
      case 'variable_declaration':
        this.declareDeclarators(node, 'var', childScope, true);
        break;
      case 'class_declaration': {
        const name = node.childForFieldName('name');
        if (name) this.declare(name, 'class', childScope, false);
        break;
      }
      case 'catch_clause': {
        const param = node.childForFieldName('parameter');
        if (param) this.declarePattern(param, 'catch', childScope, false);
        break;
      }
      case 'for_in_statement':
      case 'for_of_statement': {
        // `for (const x of xs)` — the `kind` keyword marks a declaration; a bare
        // `for (x of xs)` left is an assignment, resolved at use time instead.
        const kindNode = node.childForFieldName('kind');
        const left = node.childForFieldName('left');
        if (kindNode && left) {
          const k = kindNode.type === 'var' ? 'var' : kindNode.type === 'const' ? 'const' : 'let';
          this.declarePattern(left, k, childScope, k === 'var');
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

  private declareDeclarators(
    declNode: SyntaxNode,
    kind: 'var' | 'let' | 'const',
    scope: Scope,
    hoistToRoot: boolean,
  ): void {
    for (let i = 0; i < declNode.namedChildCount; i++) {
      const d = declNode.namedChild(i);
      if (d?.type !== 'variable_declarator') continue;
      const name = d.childForFieldName('name');
      if (name) this.declarePattern(name, kind, scope, hoistToRoot);
    }
  }

  // ── phase 2: per-statement fact extraction ───────────────────────────────

  /**
   * Def/use facts for one statement (or construct-header expression) node.
   * Safe from any walk order — resolution consults the completed scope tree.
   */
  facts(node: SyntaxNode): StatementFacts {
    const acc = new FactAccumulator(node.startPosition.row + 1);
    this.walkValue(node, acc);
    return acc.finish();
  }

  /**
   * Facts for an expression whose WHOLE evaluation is conditional (switch
   * case tests, which only run when earlier cases didn't match) — every def
   * inside becomes a may-def.
   */
  factsConditional(node: SyntaxNode): StatementFacts {
    const acc = new FactAccumulator(node.startPosition.row + 1);
    this.conditional(() => this.walkValue(node, acc));
    return acc.finish();
  }

  /** Facts for a `for (left in/of right)` head: left binds/assigns, right is used. */
  forInHeadFacts(stmt: SyntaxNode): StatementFacts {
    const acc = new FactAccumulator(stmt.startPosition.row + 1);
    const left = stmt.childForFieldName('left');
    const right = stmt.childForFieldName('right');
    if (left) this.walkDefPattern(left, acc);
    if (right) this.walkValue(right, acc);
    return acc.finish();
  }

  /** ENTRY-block facts for the function's parameters (defs + default-value uses). */
  paramFacts(): StatementFacts | undefined {
    const fnNode = this.fnNode;
    const params = fnNode.childForFieldName('parameters') ?? fnNode.childForFieldName('parameter');
    if (!params) return undefined;
    const acc = new FactAccumulator(fnNode.startPosition.row + 1);
    if (params.type === 'identifier') {
      this.def(params, acc);
    } else {
      for (let i = 0; i < params.namedChildCount; i++) {
        const p = params.namedChild(i);
        if (!p) continue;
        const pattern = p.childForFieldName('pattern') ?? p;
        this.walkDefPattern(pattern, acc);
        const dflt = p.childForFieldName('value');
        if (dflt) this.walkValue(dflt, acc);
      }
    }
    return acc.defCount() || acc.useCount() ? acc.finish() : undefined;
  }

  /** Def fact for a `catch (e)` parameter — prepend to the handler entry block. */
  catchParamFacts(catchClause: SyntaxNode): StatementFacts | undefined {
    const param = catchClause.childForFieldName('parameter');
    if (!param) return undefined;
    const acc = new FactAccumulator(catchClause.startPosition.row + 1);
    this.walkDefPattern(param, acc);
    return acc.defCount() ? acc.finish() : undefined;
  }

  private resolve(nameNode: SyntaxNode): number {
    const name = nameNode.text;
    // Fast path: the prescan cached every visited node's innermost scope, so
    // resolution walks the SCOPE chain (shallow), not the AST parent chain
    // (arbitrarily deep in chained expressions). The parent-chain walk remains
    // as fallback for the few nodes the prescan never visits (e.g. a nested
    // function declaration's own name node).
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
    // No in-function declaration — synthetic module-level binding, shared by
    // defs and uses so `notDeclared = 1; use(notDeclared)` still forms a fact.
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

  /** Run `fn` with defs demoted to may-defs (conditionally-evaluated context). */
  private conditional(fn: () => void): void {
    this.conditionalDepth++;
    try {
      fn();
    } finally {
      this.conditionalDepth--;
    }
  }

  /** Strip wrappers that don't change the lvalue (`(x) += 1`, `x! ++`). */
  private unwrapLvalue(node: SyntaxNode): SyntaxNode {
    let n = node;
    while (n.type === 'parenthesized_expression' || n.type === 'non_null_expression') {
      const inner = n.namedChild(0);
      if (!inner) break;
      n = inner;
    }
    return n;
  }

  private use(nameNode: SyntaxNode, acc: FactAccumulator): void {
    acc.addUse(this.resolve(nameNode));
  }

  /** Value-position walk: collect uses; route def positions to the pattern walk. */
  private walkValue(node: SyntaxNode, acc: FactAccumulator): void {
    const t = node.type;
    if (TYPE_CONTEXT_TYPES.has(t)) return;
    if (NESTED_FUNCTION_TYPES.has(t) && node.id !== this.fnId) {
      // Opaque nested function: its NAME (function declaration) is a def in
      // the enclosing scope; captured reads/writes inside are invisible (KTD4).
      if (FUNCTION_DECL_TYPES.has(t)) {
        const name = node.childForFieldName('name');
        if (name) this.def(name, acc);
      }
      return;
    }

    switch (t) {
      case 'identifier':
      case 'shorthand_property_identifier':
        this.use(node, acc);
        return;
      case 'lexical_declaration':
      case 'variable_declaration':
        for (let i = 0; i < node.namedChildCount; i++) {
          const d = node.namedChild(i);
          if (d?.type !== 'variable_declarator') continue;
          const name = d.childForFieldName('name');
          const value = d.childForFieldName('value');
          // A bare `var x;` mid-function is hoisted and writes NOTHING at
          // runtime — harvesting it as a def would fabricate a kill of the
          // live def (`x = source(); var x; sink(x)` must keep source→sink;
          // tri-review P2). `let`/`const` declarators genuinely initialize.
          if (name && (value || t === 'lexical_declaration')) {
            this.walkDefPattern(name, acc);
          }
          if (value) this.walkValue(value, acc);
        }
        return;
      case 'assignment_expression': {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (left) this.walkDefPattern(this.unwrapLvalue(left), acc);
        if (right) this.walkValue(right, acc);
        return;
      }
      case 'augmented_assignment_expression': {
        // `x += y` both defines and uses x. The logical-assignment operators
        // (`||=`, `&&=`, `??=`) only WRITE conditionally — their def is a
        // may-def (the read always happens).
        const left = node.childForFieldName('left')
          ? this.unwrapLvalue(node.childForFieldName('left') as SyntaxNode)
          : null;
        const right = node.childForFieldName('right');
        const op = node.childForFieldName('operator')?.type ?? '';
        const logical = op === '||=' || op === '&&=' || op === '??=';
        if (left?.type === 'identifier') {
          if (logical) this.conditional(() => this.def(left, acc));
          else this.def(left, acc);
          this.use(left, acc);
        } else if (left) {
          this.walkValue(left, acc); // member/subscript target — uses only
        }
        // The RHS of a logical assignment is itself conditionally evaluated.
        if (right) {
          if (logical) this.conditional(() => this.walkValue(right, acc));
          else this.walkValue(right, acc);
        }
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
        // Short-circuit operators evaluate their RIGHT operand conditionally:
        // a def inside it (`a && (x = clean())`, `c ?? (c = load())`) must be
        // a may-def or the not-taken path's prior def is falsely killed
        // (tri-review P1). Other binary operators evaluate both sides.
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        const op = node.childForFieldName('operator')?.type ?? '';
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
      case 'ternary_expression': {
        // Each arm is conditionally evaluated — defs inside are may-defs.
        const cond = node.childForFieldName('condition');
        const consequence = node.childForFieldName('consequence');
        const alternative = node.childForFieldName('alternative');
        if (cond) this.walkValue(cond, acc);
        if (consequence) this.conditional(() => this.walkValue(consequence, acc));
        if (alternative) this.conditional(() => this.walkValue(alternative, acc));
        return;
      }
      case 'class_declaration': {
        // The class NAME is a def (prescan declared the binding) — without
        // this case the default walk would record it as a bogus USE in plain
        // JS (the name is an `identifier` there; in TS it's a type_identifier
        // and would be silently skipped, losing the def either way). The body
        // walk picks up field-initializer uses; methods are opaque nested fns.
        const name = node.childForFieldName('name');
        if (name) this.def(name, acc);
        const body = node.childForFieldName('body');
        if (body) this.walkValue(body, acc);
        return;
      }
      case 'class': {
        // Class EXPRESSION: its name (if any) binds only inside the class —
        // not a def in the enclosing function. Walk only the body.
        const body = node.childForFieldName('body');
        if (body) this.walkValue(body, acc);
        return;
      }
      default:
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (c) this.walkValue(c, acc);
        }
    }
  }

  /** Assignment-target walk: identifiers bind; member/subscript targets are uses. */
  private walkDefPattern(node: SyntaxNode, acc: FactAccumulator): void {
    switch (node.type) {
      case 'identifier':
      case 'shorthand_property_identifier_pattern':
        this.def(node, acc);
        return;
      case 'rest_pattern':
      case 'object_pattern':
      case 'array_pattern':
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (c) this.walkDefPattern(c, acc);
        }
        return;
      case 'pair_pattern': {
        const key = node.childForFieldName('key');
        const value = node.childForFieldName('value');
        if (key?.type === 'computed_property_name') this.walkValue(key, acc);
        if (value) this.walkDefPattern(value, acc);
        return;
      }
      case 'assignment_pattern':
      case 'object_assignment_pattern': {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (left) this.walkDefPattern(left, acc);
        if (right) this.walkValue(right, acc);
        return;
      }
      case 'member_expression':
      case 'subscript_expression':
        // Property/element write — NOT a scalar def (KTD4); its identifiers
        // (object, computed key) are uses.
        this.walkValue(node, acc);
        return;
      default:
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (c && !TYPE_CONTEXT_TYPES.has(c.type)) this.walkDefPattern(c, acc);
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

  /** A def that may not execute (conditional context) — gen without kill. */
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

  useCount(): number {
    return this.uses.length;
  }

  finish(): StatementFacts {
    return {
      line: this.line,
      defs: this.defs,
      uses: this.uses,
      // Optional field stays absent when empty — keeps the serialized
      // side-channel payload lean (most statements have no may-defs).
      ...(this.mayDefs.length > 0 ? { mayDefs: this.mayDefs } : {}),
    };
  }
}
