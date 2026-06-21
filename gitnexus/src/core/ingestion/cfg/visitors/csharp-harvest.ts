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
import { CallSiteFactAccumulator } from './call-site-harvest.js';
import { ScopeTreeHarvester, type Scope, type FactAccumulator } from './scope-tree-harvest.js';

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

export class CsharpHarvester extends ScopeTreeHarvester {
  constructor(fnNode: SyntaxNode) {
    super(fnNode);
    this.declareParams(fnNode);
    const body = this.bodyOf(fnNode);
    if (body) this.prescan(body, this.openScope(body));
  }

  /** The function/lambda body node (a `block` or an expression for `=> expr`). */
  private bodyOf(fnNode: SyntaxNode): SyntaxNode | undefined {
    const body = fnNode.childForFieldName('body');
    if (body) return body;
    // Anonymous method / local function: the body is the first `block` child.
    return fnNode.namedChildren.find((c) => c.type === 'block');
  }

  // ── phase 1: declaration pre-scan ────────────────────────────────────────

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

  protected prescan(node: SyntaxNode, scope: Scope): void {
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
      case 'declaration_expression': {
        // `f(out var n)` / `f(out int n)` — `n` is a fresh out-binding written
        // by the callee; declare it so its def + later uses resolve to a real
        // local rather than a synthetic module binding.
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
      if (name) {
        this.declare(name, 'var', scope);
      } else {
        // Deconstruction declaration `var (a, b) = …;` — the declarator's name
        // slot is a `tuple_pattern`; declare each identifier under it (reusing
        // the foreach tuple-target logic).
        const tuple = d.namedChildren.find((c) => c.type === 'tuple_pattern');
        if (tuple) this.declareForeachTarget(tuple, scope);
      }
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

  /**
   * Def-ONLY facts for a value-position binding carrier (`var x = k switch {…}`,
   * #2207): just the declared name(s)' def, attached to the continuation block the
   * switch arms rejoin. The discriminant + arm-value USES are already harvested
   * onto the branch's own blocks ({@link facts} on each arm), so this must NOT
   * re-walk the initializer — only each `variable_declarator`'s name is a def here.
   */
  bindingDefFacts(stmt: SyntaxNode): StatementFacts | undefined {
    const acc = new FactAccumulator(stmt.startPosition.row + 1);
    const decl = stmt.namedChildren.find((c) => c.type === 'variable_declaration');
    if (decl) {
      for (let i = 0; i < decl.namedChildCount; i++) {
        const d = decl.namedChild(i);
        if (d?.type !== 'variable_declarator') continue;
        const name = d.childForFieldName('name');
        if (name) this.def(name, acc);
      }
    }
    return acc.defCount() ? acc.finish() : undefined;
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
            if (!name) {
              // Deconstruction declaration `var (a, b) = e;` — def each
              // identifier in the `tuple_pattern`; the initializer is the
              // declarator's non-pattern child.
              const tuple = d.namedChildren.find((c) => c.type === 'tuple_pattern');
              const tupleInit = d.namedChildren.find((c) => c.type !== 'tuple_pattern');
              if (tuple) {
                const snap = acc.defSnapshot();
                this.defTupleTargets(tuple, acc);
                if (tupleInit) this.registerResultDefs(tupleInit, acc.defsSince(snap));
              }
              if (tupleInit) this.walkValue(tupleInit, acc);
              continue;
            }
            // The initializer (if any) is the LAST named child after `name`.
            const init = this.declaratorInit(d);
            if (name && init) {
              const snap = acc.defSnapshot();
              this.def(name, acc);
              this.registerResultDefs(init, acc.defsSince(snap));
            }
            if (init) this.walkValue(init, acc);
          }
        }
        return;
      }
      case 'declaration_expression': {
        // `out var n` / `out int n` — the callee writes `n` (a must-def: C#
        // requires an out parameter to be assigned before the method returns).
        const name = node.childForFieldName('name');
        if (name) this.def(name, acc);
        return;
      }
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
            if (op === '=' && right) this.registerResultDefs(right, acc.defsSince(snap));
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
      case 'invocation_expression':
        // #2195 U6: explicit case (previously default-descended) — same uses,
        // plus a taint-site record. Defs/uses stay byte-identical.
        this.visitCall(node, acc, 'call');
        return;
      case 'object_creation_expression':
        // `new Foo(x)` — constructor call site (`type` field is the callee).
        this.visitCall(node, acc, 'new');
        return;
      case 'member_access_expression': {
        // `a.B` — value read of the chain root only; the member name is not a
        // scalar binding. Mirrors the TS member-read use semantics, plus a
        // member-read site for the innermost identifier-rooted access.
        this.walkChain(node, acc, false);
        return;
      }
      default:
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (c) this.walkValue(c, acc);
        }
    }
  }

  // ── taint-site harvest (#2195 U6) ────────────────────────────────────────

  /**
   * When `value`'s root (after stripping parens) is an invocation/creation
   * node, remember that its site should carry `resultDefs: defs` — consumed by
   * {@link visitCall} once the value walk reaches the node.
   */
  private registerResultDefs(value: SyntaxNode, defs: readonly number[]): void {
    if (defs.length === 0) return;
    const root = this.unwrapLvalue(value);
    if (root.type === 'invocation_expression' || root.type === 'object_creation_expression') {
      this.resultDefTargets.set(root.id, [...defs]);
    }
  }

  /**
   * Explicit invocation / object-creation handler: records a call site (callee
   * path, receiver, per-arg occurrence entries, result defs) while reproducing
   * EXACTLY the uses the old default descent recorded. C# wraps each argument in
   * an `argument` node; `new Foo(...)` reads the `type` field as the callee.
   */
  private visitCall(node: SyntaxNode, acc: FactAccumulator, kind: 'call' | 'new'): void {
    const calleeNode = node.childForFieldName(kind === 'new' ? 'type' : 'function');
    const argsNode = node.childForFieldName('arguments');
    // `node` IS the call/object-creation expression — the SAME node the
    // scope-extractor anchors `@reference.call.*` (its `atRange`) on (KTD7).
    const siteIdx = acc.openCallSite(kind, [node.startPosition.row + 1, node.startPosition.column]);
    acc.pushFrame(siteIdx);
    let calleePath: string | undefined;
    if (calleeNode) {
      const callee = this.unwrapLvalue(calleeNode);
      if (callee.type === 'identifier') {
        // For a `new Foo(...)`, the `type` is a type name, not a scalar
        // binding — record neither a use nor an occurrence for it; for a bare
        // call the callee name is a statement-level use but not an occurrence.
        if (kind === 'call') acc.addUseWithoutOccurrence(this.resolve(callee));
        calleePath = callee.text;
      } else if (callee.type === 'member_access_expression') {
        // skipFinalRead: the final access IS the callee, carried by the path.
        // A static dotted path (`System.Console.WriteLine(...)`) parses as a
        // member_access_expression chain too, so this one branch covers both
        // instance and static dotted callees.
        const chain = this.walkChain(callee, acc, true);
        calleePath = chain.path;
        if (chain.rootIdx !== undefined) acc.setSiteReceiver(siteIdx, chain.rootIdx);
      } else {
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
        // C# wraps each value in an `argument` node; the value is the inner
        // expression (a named argument `name: x` exposes the label through the
        // `name` field — skip it so `x` is what flows).
        if (!arg || arg.type === 'comment') continue;
        acc.setFrameArg(pos);
        const value = arg.type === 'argument' ? this.argumentValue(arg) : arg;
        if (value) this.walkValue(value, acc);
        pos++;
      }
    }
    acc.popFrame();
  }

  /**
   * The value expression inside an `argument` node. A named argument
   * (`name: x`) carries the label on the `name` field and the value as a
   * sibling; a positional argument is just the value. Returns the last named
   * child that is not the `name`-field label (and skips `ref`/`out`/`in`
   * modifier keywords, which are anonymous tokens, not named children).
   */
  private argumentValue(arg: SyntaxNode): SyntaxNode | undefined {
    const label = arg.childForFieldName('name');
    for (let i = arg.namedChildCount - 1; i >= 0; i--) {
      const c = arg.namedChild(i);
      if (c && c.id !== label?.id) return c;
    }
    return undefined;
  }

  /**
   * Member chain walk shared by value position and callee position. Records the
   * chain-root identifier as a use (identical to the old default descent), plus
   * at most ONE member-read site — the INNERMOST access — when the root is an
   * identifier; `skipFinalRead` suppresses it when that access is the callee.
   */
  private walkChain(
    node: SyntaxNode,
    acc: FactAccumulator,
    skipFinalRead: boolean,
  ): { path?: string; rootIdx?: number } {
    const accesses: string[] = [];
    let cur: SyntaxNode = this.unwrapLvalue(node);
    for (;;) {
      if (cur.type === 'member_access_expression') {
        const name = cur.childForFieldName('name');
        accesses.unshift(name?.text ?? '');
        const expr = cur.childForFieldName('expression');
        if (!expr) break;
        cur = this.unwrapLvalue(expr);
      } else {
        break;
      }
    }
    let rootIdx: number | undefined;
    let rootSegment: string | undefined;
    if (cur.type === 'identifier') {
      rootIdx = this.resolve(cur);
      acc.addUse(rootIdx);
      rootSegment = cur.text;
    } else {
      this.walkValue(cur, acc);
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

  /**
   * The initializer value of a `variable_declarator` — the named child after
   * `name`. NOTE: deliberately duplicated in `csharp.ts` (the visitor is a
   * standalone class with no shared base — repo convention). The two copies must
   * stay in sync; there is no C#-specific shared module to host it, and the only
   * module both files share is the generic `utils/ast-helpers` (types only).
   */
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

/**
 * Ordered, deduplicating def/use + call-site collector for one statement record.
 * The shared {@link CallSiteFactAccumulator} carries the def/use machinery the
 * old local class had, plus the taint-site harvest (#2195 U6).
 */
const FactAccumulator = CallSiteFactAccumulator;
