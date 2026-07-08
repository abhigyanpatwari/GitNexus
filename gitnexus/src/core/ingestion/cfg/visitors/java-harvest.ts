/**
 * Java def/use harvester (#2195 U4, plan KTD2) — the Java analogue of
 * {@link import('./typescript-harvest.js').TsHarvester} and the closely-related
 * {@link import('./csharp-harvest.js').CsharpHarvester}.
 *
 * Runs in the parse worker next to the Java CFG visitor, extracting per-statement
 * variable definition/use facts that ride the side channel for the reaching-defs
 * / CDG solvers. Output is the per-function binding table ({@link BindingEntry}[])
 * plus {@link StatementFacts} the visitor attaches to blocks as it walks.
 *
 * TWO-PHASE, ORDER-INDEPENDENT (load-bearing — mirrors the TS / C# harvesters):
 * the CFG walk is NOT source-order (`visitFor` builds the init block after the
 * body, `visitDoWhile` the condition before the body), so resolving names against
 * a scope stack populated *during* the walk would mis-resolve. Phase 1 pre-scans
 * the whole function subtree once into a completed lexical scope tree; phase 2
 * resolves defs/uses against that finished tree from any walk order.
 *
 * v1 def-semantics scope:
 *   - `local_variable_declaration` → `variable_declarator` (an INITIALIZED local
 *     is a def; a bare `int x;` with no initializer writes nothing at runtime —
 *     not a def, like the TS bare-`var` rule).
 *   - `assignment_expression` (plain + compound `+=` etc.) and `update_expression`
 *     (`x++` / `--x`) — define and (for compound / update) also use the lvalue.
 *   - parameters (`formal_parameter` / `spread_parameter` → `name`), the
 *     enhanced-for loop variable (`enhanced_for_statement` field `name`), and
 *     catch parameters (`catch_formal_parameter` → `name`), incl. multi-catch.
 * EXCLUDED, deliberately (TypeScript-CFA precedent): field / array writes
 * (`obj.f = …`, `a[i] = …`) are NOT scalar defs — their identifiers are uses
 * only. Nested-function (lambda) bodies are opaque in BOTH directions (writes to
 * and reads of captured outer variables are invisible).
 *
 * MAY-DEFS: a def inside a conditionally-evaluated subexpression — the right
 * operand of `&&` / `||` (`a && (x = f())`), a ternary arm, or a switch case test
 * — is a may-def (gen without kill), so the not-taken path's prior def is not
 * falsely killed. (Java has no `??`.)
 *
 * Identifiers with no in-function declaration (fields, statics, imported names)
 * resolve to a SYNTHETIC module-level binding (`name@module`), applied
 * identically by def and use harvesting.
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
  'method_declaration',
  'constructor_declaration',
  'compact_constructor_declaration',
]);

/**
 * Nodes that open a lexical scope for block-local declarations. A `block` is one
 * scope; the loop constructs open a scope for their loop variable; a
 * `catch_clause` scopes its exception name; a `try_with_resources_statement`
 * scopes its resource declarations; a switch group/rule scopes its statements.
 */
const SCOPE_TYPES = new Set([
  'block',
  'for_statement',
  'enhanced_for_statement',
  'while_statement',
  'do_statement',
  'catch_clause',
  'try_with_resources_statement',
  'switch_block_statement_group',
  'switch_rule',
]);

/** Comment node types tree-sitter-java surfaces (NOT `comment`). */
const COMMENT_TYPES = new Set(['line_comment', 'block_comment']);

export class JavaHarvester extends ScopeTreeHarvester {
  constructor(fnNode: SyntaxNode) {
    super(fnNode);
    this.declareParams(fnNode);
    const body = this.bodyOf(fnNode);
    if (body && body.type === 'block') this.prescan(body, this.openScope(body));
  }

  /** The function/lambda body node (a `block`, or an expression for `x -> expr`). */
  private bodyOf(fnNode: SyntaxNode): SyntaxNode | undefined {
    const body = fnNode.childForFieldName('body');
    if (body) return body;
    return fnNode.namedChildren.find((c) => c.type === 'block');
  }

  // ── phase 1: declaration pre-scan ────────────────────────────────────────

  private declareParams(fnNode: SyntaxNode): void {
    const params = fnNode.childForFieldName('parameters');
    if (!params) {
      // Lambda single un-parenthesized parameter: `x -> …` (a bare identifier).
      const lambdaParam = fnNode.namedChildren.find((c) => c.type === 'identifier');
      if (fnNode.type === 'lambda_expression' && lambdaParam) {
        this.declare(lambdaParam, 'param', this.root);
      }
      // Lambda inferred parameters: `(x, y) -> …`.
      const inferred = fnNode.namedChildren.find((c) => c.type === 'inferred_parameters');
      if (inferred) {
        for (let i = 0; i < inferred.namedChildCount; i++) {
          const p = inferred.namedChild(i);
          if (p?.type === 'identifier') this.declare(p, 'param', this.root);
        }
      }
      return;
    }
    for (let i = 0; i < params.namedChildCount; i++) {
      const p = params.namedChild(i);
      if (p?.type !== 'formal_parameter' && p?.type !== 'spread_parameter') continue;
      const name = this.paramName(p);
      if (name) this.declare(name, 'param', this.root);
    }
  }

  /** The `name` identifier of a `formal_parameter` / `spread_parameter`. */
  private paramName(param: SyntaxNode): SyntaxNode | undefined {
    const named = param.childForFieldName('name');
    if (named) return named;
    // `spread_parameter` (`int... xs`) exposes its name through a nested
    // variable_declarator rather than a `name` field.
    const declarator = param.namedChildren.find((c) => c.type === 'variable_declarator');
    return declarator?.childForFieldName('name');
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
      case 'local_variable_declaration':
        this.declareVariableDeclaration(node, childScope);
        break;
      case 'enhanced_for_statement': {
        const name = node.childForFieldName('name');
        if (name) this.declare(name, 'var', childScope);
        break;
      }
      case 'resource': {
        // `try (var f = open())` — the resource binds in the try scope.
        const name = node.childForFieldName('name');
        if (name) this.declare(name, 'var', childScope);
        break;
      }
      case 'catch_clause': {
        const param = node.namedChildren.find((c) => c.type === 'catch_formal_parameter');
        const name = param?.childForFieldName('name');
        if (name) this.declare(name, 'catch', childScope);
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

  /** Declare every `variable_declarator` name in a `local_variable_declaration`. */
  private declareVariableDeclaration(declNode: SyntaxNode, scope: Scope): void {
    for (let i = 0; i < declNode.namedChildCount; i++) {
      const d = declNode.namedChild(i);
      if (d?.type !== 'variable_declarator') continue;
      const name = d.childForFieldName('name');
      if (name) this.declare(name, 'var', scope);
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
   * switch arms rejoin. The switch subject + arm-value USES are already harvested
   * onto the branch's own blocks ({@link facts} on each arm), so this must NOT
   * re-walk the value — only each `variable_declarator`'s `name` is a def here.
   */
  bindingDefFacts(stmt: SyntaxNode): StatementFacts | undefined {
    const acc = new FactAccumulator(stmt.startPosition.row + 1);
    for (let i = 0; i < stmt.namedChildCount; i++) {
      const d = stmt.namedChild(i);
      if (d?.type !== 'variable_declarator') continue;
      const name = d.childForFieldName('name');
      if (name) this.def(name, acc);
    }
    return acc.defCount() ? acc.finish() : undefined;
  }

  /** Facts for a `for (T name : value)` head: name binds, value is used. */
  forEachHeadFacts(stmt: SyntaxNode): StatementFacts {
    const acc = new FactAccumulator(stmt.startPosition.row + 1);
    const name = stmt.childForFieldName('name');
    const value = stmt.childForFieldName('value');
    if (name) this.def(name, acc);
    if (value) this.walkValue(value, acc);
    return acc.finish();
  }

  /** Facts for the resource-close finalizer: each resource is USED on close. */
  resourceCloseFacts(resources: readonly SyntaxNode[]): StatementFacts | undefined {
    const first = resources[0];
    if (!first) return undefined;
    const acc = new FactAccumulator(first.startPosition.row + 1);
    for (const r of resources) {
      const name = r.childForFieldName('name');
      if (name) this.use(name, acc);
    }
    return acc.useCount() ? acc.finish() : undefined;
  }

  /** ENTRY-block facts for the function's parameters (defs only). */
  paramFacts(): StatementFacts | undefined {
    const acc = new FactAccumulator(this.fnNode.startPosition.row + 1);
    const params = this.fnNode.childForFieldName('parameters');
    if (params) {
      for (let i = 0; i < params.namedChildCount; i++) {
        const p = params.namedChild(i);
        if (p?.type !== 'formal_parameter' && p?.type !== 'spread_parameter') continue;
        const name = this.paramName(p);
        if (name) this.def(name, acc);
      }
    } else if (this.fnNode.type === 'lambda_expression') {
      const lambdaParam = this.fnNode.namedChildren.find((c) => c.type === 'identifier');
      if (lambdaParam) this.def(lambdaParam, acc);
      const inferred = this.fnNode.namedChildren.find((c) => c.type === 'inferred_parameters');
      if (inferred) {
        for (let i = 0; i < inferred.namedChildCount; i++) {
          const p = inferred.namedChild(i);
          if (p?.type === 'identifier') this.def(p, acc);
        }
      }
    }
    return acc.defCount() ? acc.finish() : undefined;
  }

  /** Def fact for a `catch (T e)` parameter — prepend to the handler entry block. */
  catchParamFacts(catchClause: SyntaxNode): StatementFacts | undefined {
    const param = catchClause.namedChildren.find((c) => c.type === 'catch_formal_parameter');
    const name = param?.childForFieldName('name');
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
      const inner = n.namedChildren.find((c) => !COMMENT_TYPES.has(c.type));
      if (!inner) break;
      n = inner;
    }
    return n;
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
      case 'local_variable_declaration': {
        for (let i = 0; i < node.namedChildCount; i++) {
          const d = node.namedChild(i);
          if (d?.type !== 'variable_declarator') continue;
          const name = d.childForFieldName('name');
          const value = d.childForFieldName('value');
          // Only an INITIALIZED declarator writes (`int x = e;`). A bare
          // `int x;` is not a def (it writes nothing at runtime), matching the
          // TS bare-`var` rule.
          if (name && value) {
            const snap = acc.defSnapshot();
            this.def(name, acc);
            this.registerResultDefs(value, acc.defsSince(snap));
          }
          if (value) this.walkValue(value, acc);
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
            const snap = acc.defSnapshot();
            this.def(lv, acc);
            if (op !== '=') this.use(lv, acc); // compound assign reads too
            if (op === '=' && right) this.registerResultDefs(right, acc.defsSince(snap));
          } else {
            this.walkValue(lv, acc); // field/array target — uses only
          }
        }
        if (right) this.walkValue(right, acc);
        return;
      }
      case 'update_expression': {
        // `x++` / `++x` / `x--` / `--x` — the only writing unary ops. The operand
        // is an anonymous (non-field) child; treat as def+use when it's an
        // identifier.
        const operand = this.updateOperand(node);
        const lv = operand ? this.unwrapLvalue(operand) : null;
        if (lv?.type === 'identifier') {
          this.def(lv, acc);
          this.use(lv, acc);
        } else if (operand) {
          this.walkValue(operand, acc);
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
      case 'ternary_expression': {
        const cond = node.childForFieldName('condition');
        const cons = node.childForFieldName('consequence');
        const alt = node.childForFieldName('alternative');
        if (cond) this.walkValue(cond, acc);
        if (cons) this.conditional(() => this.walkValue(cons, acc));
        if (alt) this.conditional(() => this.walkValue(alt, acc));
        return;
      }
      case 'method_invocation':
        // #2195 U6: explicit case (previously default-descended) — same uses,
        // plus a taint-site record. Defs/uses stay byte-identical.
        this.visitCall(node, acc);
        return;
      case 'object_creation_expression':
        // `new Foo(x)` — constructor call site (`type` field is the callee).
        this.visitNew(node, acc);
        return;
      case 'field_access': {
        // `a.b` — value read of the object root only; the field name is not a
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
   * When `value`'s root (after stripping parens) is a method-invocation /
   * object-creation node, remember its site should carry `resultDefs: defs`.
   */
  private registerResultDefs(value: SyntaxNode, defs: readonly number[]): void {
    if (defs.length === 0) return;
    const root = this.unwrapLvalue(value);
    if (root.type === 'method_invocation' || root.type === 'object_creation_expression') {
      this.resultDefTargets.set(root.id, [...defs]);
    }
  }

  /**
   * Explicit `method_invocation` handler. Unlike a member-chain callee, Java
   * carries the method NAME on the `name` field and the receiver on a sibling
   * `object` field (`db.query(x)` ⇒ object `db`, name `query`); a bare call
   * (`exec(x)`) has no `object`. Reproduces EXACTLY the uses the old default
   * descent recorded (object root + arguments) and adds the call site.
   */
  private visitCall(node: SyntaxNode, acc: FactAccumulator): void {
    const objectNode = node.childForFieldName('object');
    const nameNode = node.childForFieldName('name');
    const argsNode = node.childForFieldName('arguments');
    // `node` IS the method_invocation — the SAME node the scope-extractor
    // anchors `@reference.call.*` (its `atRange`) on (KTD7).
    const siteIdx = acc.openCallSite('call', [
      node.startPosition.row + 1,
      node.startPosition.column,
    ]);
    acc.pushFrame(siteIdx);
    let receiverPath: string | undefined;
    if (objectNode) {
      // The receiver is a value read (object chain root) — record its uses and
      // the member-read sites, and capture its dotted path + binding root.
      const chain = this.walkChain(objectNode, acc, false);
      receiverPath = chain.path;
      if (chain.rootIdx !== undefined) acc.setSiteReceiver(siteIdx, chain.rootIdx);
    }
    if (nameNode) {
      // The method NAME was a (synthetic) statement-level use under the old
      // default descent — preserve it byte-identically, but never as a value
      // occurrence in an enclosing argument (`exec(escape(x))` must not put the
      // `escape` name into exec's arg 0).
      acc.addUseWithoutOccurrence(this.resolve(nameNode));
      const callee =
        receiverPath !== undefined ? `${receiverPath}.${nameNode.text}` : nameNode.text;
      acc.setSiteCallee(siteIdx, callee);
    }
    const resultDefs = this.resultDefTargets.get(node.id);
    if (resultDefs !== undefined) acc.setSiteResultDefs(siteIdx, resultDefs);
    this.walkArgs(argsNode, acc);
    acc.popFrame();
  }

  /** Explicit `object_creation_expression` (`new Foo(x)`) handler. */
  private visitNew(node: SyntaxNode, acc: FactAccumulator): void {
    const typeNode = node.childForFieldName('type');
    const argsNode = node.childForFieldName('arguments');
    // `node` IS the object_creation_expression — the SAME node the
    // scope-extractor anchors `@reference.call.constructor` (its `atRange`) on.
    const siteIdx = acc.openCallSite('new', [
      node.startPosition.row + 1,
      node.startPosition.column,
    ]);
    acc.pushFrame(siteIdx);
    if (typeNode) {
      // The type name is not a scalar binding — record it only as the callee
      // path, never a use/occurrence (matches the type-position semantics).
      acc.setSiteCallee(siteIdx, typeNode.text.replace(/\s+/g, ''));
    }
    const resultDefs = this.resultDefTargets.get(node.id);
    if (resultDefs !== undefined) acc.setSiteResultDefs(siteIdx, resultDefs);
    this.walkArgs(argsNode, acc);
    acc.popFrame();
  }

  /** Walk an `argument_list`, tagging each positional argument for occurrences. */
  private walkArgs(argsNode: SyntaxNode | null, acc: FactAccumulator): void {
    if (!argsNode) return;
    let pos = 0;
    for (let i = 0; i < argsNode.namedChildCount; i++) {
      const arg = argsNode.namedChild(i);
      if (!arg || COMMENT_TYPES.has(arg.type)) continue;
      acc.setFrameArg(pos);
      this.walkValue(arg, acc);
      pos++;
    }
  }

  /**
   * `field_access` chain walk shared by value position and the method-invocation
   * receiver. Records the chain-root identifier as a use (identical to the old
   * default descent) plus at most ONE member-read site — the INNERMOST access —
   * when the root is an identifier; `skipFinalRead` suppresses it when that
   * access is the callee (never the case for `field_access`, which is value-only).
   */
  private walkChain(
    node: SyntaxNode,
    acc: FactAccumulator,
    skipFinalRead: boolean,
  ): { path?: string; rootIdx?: number } {
    const accesses: string[] = [];
    let cur: SyntaxNode = this.unwrapLvalue(node);
    for (;;) {
      if (cur.type === 'field_access') {
        const field = cur.childForFieldName('field');
        accesses.unshift(field?.text ?? '');
        const obj = cur.childForFieldName('object');
        if (!obj) break;
        cur = this.unwrapLvalue(obj);
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
    } else if (cur.type === 'this' || cur.type === 'super') {
      rootSegment = cur.text; // `this`/`super` are path segments, never bind
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

  /** The operand identifier of an `update_expression` (`x++` / `--x`). */
  private updateOperand(node: SyntaxNode): SyntaxNode | undefined {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c && !COMMENT_TYPES.has(c.type)) return c;
    }
    return undefined;
  }
}

/**
 * Ordered, deduplicating def/use + call-site collector for one statement record.
 * The shared {@link CallSiteFactAccumulator} carries the def/use machinery the
 * old local class had, plus the taint-site harvest (#2195 U6).
 */
const FactAccumulator = CallSiteFactAccumulator;
