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
import { CallSiteFactAccumulator } from './call-site-harvest.js';
import { ScopeTreeHarvester, type Scope, type FactAccumulator } from './scope-tree-harvest.js';

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

export class CCppHarvester extends ScopeTreeHarvester {
  constructor(fnNode: SyntaxNode) {
    super(fnNode);
    this.declareParams(fnNode);
    const body = this.bodyOf(fnNode);
    if (body) this.prescan(body, this.openScope(body));
  }

  /** The function/lambda body block (`compound_statement`). */
  private bodyOf(fnNode: SyntaxNode): SyntaxNode | undefined {
    const body = fnNode.childForFieldName('body');
    if (body) return body;
    return fnNode.namedChildren.find((c) => c.type === 'compound_statement');
  }

  // ── phase 1: declaration pre-scan ────────────────────────────────────────

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

  protected prescan(node: SyntaxNode, scope: Scope): void {
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

  /**
   * The `structured_binding_declarator` a declarator binds (C++17 `auto [a,b]`,
   * or `auto& [a,b]` whose binding sits under a `reference_declarator`), or
   * undefined. C has no structured bindings, so this is inert for C.
   */
  private structuredBinding(declarator: SyntaxNode | null | undefined): SyntaxNode | undefined {
    let cur = declarator ?? undefined;
    let hops = 4;
    while (cur && hops-- > 0) {
      if (cur.type === 'structured_binding_declarator') return cur;
      if (cur.type !== 'reference_declarator' && cur.type !== 'pointer_declarator') break;
      cur = cur.namedChildren.find(
        (c) =>
          c.type === 'structured_binding_declarator' ||
          c.type === 'reference_declarator' ||
          c.type === 'pointer_declarator',
      );
    }
    return undefined;
  }

  /** The identifier leaves a `structured_binding_declarator` binds (`[a, b]`). */
  private structuredBindingNames(sbd: SyntaxNode): SyntaxNode[] {
    return sbd.namedChildren.filter((c) => c.type === 'identifier');
  }

  private declareDeclarators(declNode: SyntaxNode, scope: Scope): void {
    for (let i = 0; i < declNode.namedChildCount; i++) {
      const d = declNode.namedChild(i);
      if (!d) continue;
      if (d.type === 'init_declarator') {
        const declarator = d.childForFieldName('declarator');
        const sbd = this.structuredBinding(declarator);
        if (sbd) {
          // `auto [a, b] = e;` — every identifier binds a scalar local.
          for (const id of this.structuredBindingNames(sbd)) this.declare(id, 'var', scope);
        } else {
          const name = this.declaratorName(declarator ?? null);
          if (name) this.declare(name, 'var', scope);
        }
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
          const sbd = this.structuredBinding(declarator);
          if (sbd && value) {
            // `auto [a, b] = e;` — each identifier is a scalar def; the result
            // of `e` flows into all of them (resultDefs covers the whole list).
            const snap = acc.defSnapshot();
            for (const id of this.structuredBindingNames(sbd)) this.def(id, acc);
            this.registerResultDefs(value, acc.defsSince(snap));
            this.walkValue(value, acc);
            continue;
          }
          const name = declarator ? this.declaratorName(declarator) : undefined;
          // Only an INITIALIZED declarator writes (`int x = e;`). A bare
          // `int x;` is not a def (it writes nothing at runtime), matching the
          // TS bare-`var` rule. Pointer/array/member declarators are not scalar
          // defs either — their inner identifiers stay uses.
          if (name && value && declarator?.type === 'identifier') {
            const snap = acc.defSnapshot();
            this.def(name, acc);
            this.registerResultDefs(value, acc.defsSince(snap));
          } else if (declarator && declarator.type !== 'identifier') {
            this.walkValue(declarator, acc);
          }
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
            const snap = acc.defSnapshot();
            this.def(lv, acc);
            if (op !== '=') this.use(lv, acc); // compound assign reads too
            // A plain `x = f(a)` attaches `resultDefs: [x]` to f's site; a
            // compound `x += f(a)` does not (the prior value flows in too).
            if (op === '=' && right) this.registerResultDefs(right, acc.defsSince(snap));
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
      case 'call_expression':
        // #2195 U6: explicit case (previously default-descended) — same uses,
        // plus a taint-site record. Defs/uses stay byte-identical.
        this.visitCall(node, acc, 'call');
        return;
      case 'new_expression':
        // C++ `new Foo(x)` — constructor call site (`type` field is the callee).
        this.visitCall(node, acc, 'new');
        return;
      case 'field_expression': {
        // `a.b` / `a->b` — value read of the chain root only; the field name is
        // not a scalar binding. Mirrors the TS member-read use semantics, plus a
        // member-read site for the innermost identifier-rooted access.
        this.walkChain(node, acc, false);
        return;
      }
      default:
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (c && !TYPE_CONTEXT_TYPES.has(c.type)) this.walkValue(c, acc);
        }
    }
  }

  // ── taint-site harvest (#2195 U6) ────────────────────────────────────────

  /**
   * When `value`'s root (after stripping parens) is a call/new node, remember
   * that its site should carry `resultDefs: defs` — consumed by
   * {@link visitCall} once the value walk reaches the node.
   */
  private registerResultDefs(value: SyntaxNode, defs: readonly number[]): void {
    if (defs.length === 0) return;
    const root = this.unwrapLvalue(value);
    if (root.type === 'call_expression' || root.type === 'new_expression') {
      this.resultDefTargets.set(root.id, [...defs]);
    }
  }

  /**
   * Explicit call/new handler: records a call site (callee path, receiver,
   * per-arg occurrence entries, result defs) while reproducing EXACTLY the uses
   * the old default descent recorded — callee chain root + arguments. `new`
   * sites read the `type` field as the callee; `call` sites the `function`
   * field.
   */
  private visitCall(node: SyntaxNode, acc: FactAccumulator, kind: 'call' | 'new'): void {
    const calleeNode = node.childForFieldName(kind === 'new' ? 'type' : 'function');
    const argsNode = node.childForFieldName('arguments');
    // `node` IS the call/new expression — the SAME node the scope-extractor
    // anchors `@reference.call.*` (its `atRange`) on (KTD7).
    const siteIdx = acc.openCallSite(kind, [node.startPosition.row + 1, node.startPosition.column]);
    acc.pushFrame(siteIdx);
    let calleePath: string | undefined;
    if (calleeNode) {
      const callee = this.unwrapLvalue(calleeNode);
      if (callee.type === 'identifier' || callee.type === 'type_identifier') {
        // The callee NAME is a statement-level use but NOT a value occurrence in
        // any enclosing argument (`exec(escape(x))` must not put `escape` into
        // exec's arg 0). A `new Foo(...)` type identifier is a type, not a
        // scalar binding — record neither a use nor an occurrence for it.
        if (callee.type === 'identifier') acc.addUseWithoutOccurrence(this.resolve(callee));
        calleePath = callee.text;
      } else if (callee.type === 'field_expression') {
        // skipFinalRead: the final access IS the callee, carried by the dotted
        // path — recording it as a member read would double-count.
        const chain = this.walkChain(callee, acc, true);
        calleePath = chain.path;
        if (chain.rootIdx !== undefined) acc.setSiteReceiver(siteIdx, chain.rootIdx);
      } else if (callee.type === 'qualified_identifier') {
        // `ns::g(...)` — a static dotted path, no scalar receiver binding.
        calleePath = this.qualifiedPath(callee);
        this.walkValue(callee, acc);
      } else {
        // Call-rooted chains, function-pointer expressions — the walk still
        // records uses and nested sites.
        this.walkValue(callee, acc);
      }
      if (calleePath !== undefined) acc.setSiteCallee(siteIdx, calleePath);
    }
    const resultDefs = this.resultDefTargets.get(node.id);
    if (resultDefs !== undefined) acc.setSiteResultDefs(siteIdx, resultDefs);
    if (argsNode) {
      let pos = 0;
      for (let i = 0; i < argsNode.namedChildCount; i++) {
        const arg = argsNode.namedChild(i);
        if (!arg || arg.type === 'comment') continue;
        acc.setFrameArg(pos);
        this.walkValue(arg, acc);
        pos++;
      }
    }
    acc.popFrame();
  }

  /**
   * Member chain walk shared by value position and callee position. Use-
   * recording is identical to the old default descent (chain-root identifier
   * once). Member-read sites: at most ONE per chain — the INNERMOST access —
   * and only when the chain root is an identifier; `skipFinalRead` suppresses it
   * when that access is the callee (carried by the dotted path instead).
   */
  private walkChain(
    node: SyntaxNode,
    acc: FactAccumulator,
    skipFinalRead: boolean,
  ): { path?: string; rootIdx?: number } {
    // Collect field accesses outer→inner (unshift), then resolve the root.
    const accesses: string[] = [];
    let cur: SyntaxNode = this.unwrapLvalue(node);
    for (;;) {
      if (cur.type === 'field_expression') {
        const field = cur.childForFieldName('field');
        accesses.unshift(field?.text ?? '');
        const obj = cur.childForFieldName('argument');
        if (!obj) break;
        cur = this.unwrapLvalue(obj);
      } else {
        break;
      }
    }
    let rootIdx: number | undefined;
    let rootSegment: string | undefined;
    if (cur.type === 'identifier' || cur.type === 'field_identifier') {
      rootIdx = this.resolve(cur);
      acc.addUse(rootIdx);
      rootSegment = cur.text;
    } else {
      this.walkValue(cur, acc); // call-rooted etc. — uses + nested sites
    }
    const innermost = accesses[0];
    if (rootIdx !== undefined && innermost && !(skipFinalRead && accesses.length === 1)) {
      acc.addMemberRead(rootIdx, innermost);
    }
    const path =
      rootSegment !== undefined && accesses.every((a) => a !== '')
        ? [rootSegment, ...accesses].join('.')
        : undefined;
    return { path, rootIdx };
  }

  /** Dotted path of a `ns::a::b` qualified_identifier (`::` folded to `.`). */
  private qualifiedPath(node: SyntaxNode): string | undefined {
    const segs: string[] = [];
    let cur: SyntaxNode | null = node;
    let hops = 16;
    while (cur && hops-- > 0) {
      if (cur.type === 'qualified_identifier') {
        const scope = cur.childForFieldName('scope');
        const name = cur.childForFieldName('name');
        if (scope) segs.push(scope.text);
        cur = name ?? null;
      } else {
        segs.push(cur.text);
        break;
      }
    }
    return segs.length ? segs.join('.') : undefined;
  }
}

/**
 * Ordered, deduplicating def/use + call-site collector for one statement record.
 * The shared {@link CallSiteFactAccumulator} carries the def/use machinery the
 * old local class had, plus the taint-site harvest (#2195 U6).
 */
const FactAccumulator = CallSiteFactAccumulator;
