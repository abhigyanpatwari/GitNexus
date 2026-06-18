/**
 * PHP def/use harvester (PDG layer — brace-family CFG, closest to Java/C#).
 *
 * Runs in the parse worker next to the PHP CFG visitor, extracting per-statement
 * variable definition/use facts that ride the side channel for the reaching-defs
 * / CDG solvers. Output is the per-function binding table ({@link BindingEntry}[])
 * plus {@link StatementFacts} the visitor attaches to blocks as it walks. The
 * call-site substrate ({@link CallSiteFactAccumulator}) is harvested too (it is
 * INERT until a PHP source/sink model is registered).
 *
 * TWO-PHASE, ORDER-INDEPENDENT (load-bearing — mirrors the Java / C# harvesters):
 * the CFG walk is NOT source-order (`visitFor` builds the init block after the
 * body, `visitDoWhile` the condition before the body), so resolving names against
 * a scope stack populated *during* the walk would mis-resolve. Phase 1 pre-scans
 * the whole function subtree once into a completed lexical scope tree; phase 2
 * resolves defs/uses against that finished tree from any walk order.
 *
 * PHP-SPECIFIC NOTE — PHP variables are FUNCTION-SCOPED (no block scope): a `$x`
 * written inside an `if` body is the SAME variable as one written at the top
 * level (unlike Java/C# block scoping). So the harvester declares EVERY assigned/
 * parameter/foreach/catch variable into the single function-root scope; there is
 * no per-block shadowing. The grammar carries the leading `$` on `variable_name`
 * text (`$x`), which we keep as the binding name (consistent and unambiguous).
 *
 * Every node type and field literal below was grammar-validated against
 * tree-sitter-php (`php_only` export) via the introspection probe before use
 * (mandatory pre-step). PHP shapes pre-empted (verified by a real parse):
 *  - functions: `function_definition`/`method_declaration` (fields
 *    `name`/`parameters`/`body`), `anonymous_function` (`parameters`/`body` plus
 *    an `anonymous_function_use_clause` capturing outer vars), `arrow_function`
 *    (`parameters`/`body`; body is an EXPRESSION).
 *  - parameters: `simple_parameter` / `variadic_parameter` /
 *    `property_promotion_parameter`, each with a `name` field (`variable_name` or
 *    a `by_ref` wrapping one); `simple_parameter` may carry `default_value`.
 *  - assignment: `assignment_expression` (`left`/`right`),
 *    `augmented_assignment_expression` (`left`/`operator`/`right`, def+use),
 *    `update_expression` (`argument`/`operator`, def+use). An lvalue may be a
 *    `variable_name`, a `list_literal` (`[$a,$b]` / `list($a,$b)` destructure),
 *    a `member_access_expression` (`$o->p` — a USE of the object, not a scalar
 *    def), or a `subscript_expression` (`$a[$i]` — same).
 *  - `foreach_statement`: the iterable + a value `variable_name`, OR a
 *    `pair` (`$k => $v`) binding both — NO field names (positional children).
 *  - `catch_clause` (`type`/`name`/`body`): `name` is the exception
 *    `variable_name`.
 *  - conditional contexts: `binary_expression` operator `&&`/`||`/`??`,
 *    `conditional_expression` (`condition`/`body`/`alternative`; short `?:` omits
 *    `body`), and switch/match case tests.
 *
 * v1 def-semantics scope:
 *   - assignment / augmented-assignment / update to a `variable_name` (or to a
 *     `list_literal` destructure target) — define (and, for augmented/update, use)
 *     the variable.
 *   - parameters, the `foreach` value/key variable, catch parameters, and
 *     `anonymous_function` `use (...)` captures (by-value AND by-ref).
 * EXCLUDED, deliberately (TypeScript-CFA precedent, mirrored by Java): property /
 * array-element writes (`$o->p = …`, `$a[$i] = …`) are NOT scalar defs — their
 * variables are uses only. Nested-function (closure / arrow) bodies are opaque in
 * BOTH directions.
 *
 * MAY-DEFS: a def inside a conditionally-evaluated subexpression — the right
 * operand of `&&` / `||` / `??` (`$a && ($x = f())`, `$c ?? ($c = load())`), a
 * ternary arm, or a switch/match case test — is a may-def (gen without kill), so
 * the not-taken path's prior def is not falsely killed.
 *
 * Identifiers with no in-function declaration (globals, statics, imported names)
 * resolve to a SYNTHETIC module-level binding (`name@module`), applied
 * identically by def and use harvesting.
 *
 * NOTE: nothing serialized here may carry a field named `nodeId` — the durable
 * parsedfile-store reviver dedups objects keyed on that field name.
 */
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { BindingEntry, StatementFacts } from '../types.js';
import { CallSiteFactAccumulator } from './call-site-harvest.js';

/**
 * The per-statement def/use + call-site collector, aliased to the shared
 * {@link CallSiteFactAccumulator} (one name for the value and the type).
 */
type FactAccumulator = CallSiteFactAccumulator;

/** Node types that own a nested CFG — their subtrees are opaque to harvesting. */
const NESTED_FUNCTION_TYPES = new Set([
  'function_definition',
  'method_declaration',
  'anonymous_function',
  'arrow_function',
]);

export class PhpHarvester {
  private readonly bindings: BindingEntry[] = [];
  /** PHP is function-scoped: one flat table, name → binding index. */
  private readonly table = new Map<string, number>();
  private readonly synthetic = new Map<string, number>();
  private readonly fnId: number;
  /** >0 while walking a conditionally-evaluated subexpression — defs become may-defs. */
  private conditionalDepth = 0;
  /**
   * Call/new node id → bindings whose declarator/assignment VALUE is exactly
   * that call. Registered before the value walk, consumed by {@link visitCall} /
   * {@link visitNew} (mirrors the Java harvester's `resultDefTargets`).
   */
  private readonly resultDefTargets = new Map<number, number[]>();

  constructor(private readonly fnNode: SyntaxNode) {
    this.fnId = fnNode.id;
    this.declareParams(fnNode);
    this.declareUseClause(fnNode);
    const body = this.bodyOf(fnNode);
    if (body) this.prescan(body);
  }

  /** The completed binding table — pass to `CfgBuilder.finish`. */
  bindingTable(): readonly BindingEntry[] {
    return this.bindings;
  }

  /** The function/closure body node (a `compound_statement`, or an expression). */
  private bodyOf(fnNode: SyntaxNode): SyntaxNode | undefined {
    return fnNode.childForFieldName('body') ?? undefined;
  }

  // ── phase 1: declaration pre-scan ────────────────────────────────────────

  private declare(name: string, declNode: SyntaxNode, kind: BindingEntry['kind']): void {
    if (!name || this.table.has(name)) return;
    this.table.set(name, this.bindings.length);
    this.bindings.push({
      name,
      declLine: declNode.startPosition.row + 1,
      declColumn: declNode.startPosition.column,
      kind,
    });
  }

  /** The `$name` text of a parameter's `name` field (a `variable_name` or `by_ref`). */
  private paramVarName(param: SyntaxNode): SyntaxNode | undefined {
    const name = param.childForFieldName('name');
    if (!name) return undefined;
    if (name.type === 'by_ref') {
      return name.namedChildren.find((c) => c.type === 'variable_name');
    }
    return name.type === 'variable_name' ? name : undefined;
  }

  private declareParams(fnNode: SyntaxNode): void {
    const params = fnNode.childForFieldName('parameters');
    if (!params) return;
    for (let i = 0; i < params.namedChildCount; i++) {
      const p = params.namedChild(i);
      if (!p) continue;
      if (
        p.type !== 'simple_parameter' &&
        p.type !== 'variadic_parameter' &&
        p.type !== 'property_promotion_parameter'
      ) {
        continue;
      }
      const varName = this.paramVarName(p);
      if (varName) this.declare(varName.text, varName, 'param');
    }
  }

  /** `anonymous_function ... use ($a, &$b)` — each captured var binds in the closure. */
  private declareUseClause(fnNode: SyntaxNode): void {
    if (fnNode.type !== 'anonymous_function') return;
    const clause = fnNode.namedChildren.find((c) => c.type === 'anonymous_function_use_clause');
    if (!clause) return;
    for (const v of this.useClauseVars(clause)) this.declare(v.text, v, 'param');
  }

  /** The captured `variable_name`s of a `use (...)` clause (unwrapping `by_ref`). */
  private useClauseVars(clause: SyntaxNode): SyntaxNode[] {
    const out: SyntaxNode[] = [];
    for (let i = 0; i < clause.namedChildCount; i++) {
      const c = clause.namedChild(i);
      if (!c) continue;
      if (c.type === 'variable_name') out.push(c);
      else if (c.type === 'by_ref') {
        const inner = c.namedChildren.find((x) => x.type === 'variable_name');
        if (inner) out.push(inner);
      }
    }
    return out;
  }

  /**
   * Walk the function body once, declaring every assigned / foreach / catch
   * variable into the FLAT function scope (PHP has no block scoping). Nested
   * function/closure bodies are NOT descended (opaque).
   */
  private prescan(node: SyntaxNode): void {
    const t = node.type;
    if (NESTED_FUNCTION_TYPES.has(t) && node.id !== this.fnId) return;

    switch (t) {
      case 'assignment_expression': {
        const left = node.childForFieldName('left');
        if (left) this.declareLvalue(left);
        break;
      }
      case 'augmented_assignment_expression': {
        const left = node.childForFieldName('left');
        if (left && left.type === 'variable_name') this.declare(left.text, left, 'var');
        break;
      }
      case 'update_expression': {
        const arg = node.childForFieldName('argument');
        if (arg && arg.type === 'variable_name') this.declare(arg.text, arg, 'var');
        break;
      }
      case 'foreach_statement': {
        for (const v of this.foreachTargets(node)) this.declare(v.text, v, 'var');
        break;
      }
      case 'catch_clause': {
        const name = node.childForFieldName('name');
        if (name && name.type === 'variable_name') this.declare(name.text, name, 'catch');
        break;
      }
      default:
        break;
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c) this.prescan(c);
    }
  }

  /**
   * Declare the variable(s) named by an assignment lvalue: a plain
   * `variable_name`, or a `list_literal` destructure (`[$a,$b]` / `list($a,$b)`,
   * possibly keyed `["x" => $e]`). Member / subscript targets bind nothing.
   */
  private declareLvalue(left: SyntaxNode): void {
    if (left.type === 'variable_name') {
      this.declare(left.text, left, 'var');
    } else if (left.type === 'list_literal') {
      for (const v of this.listTargets(left)) this.declare(v.text, v, 'var');
    }
  }

  /** Every `variable_name` bound by a `list_literal` (including keyed entries). */
  private listTargets(list: SyntaxNode): SyntaxNode[] {
    const out: SyntaxNode[] = [];
    const walk = (n: SyntaxNode): void => {
      if (n.type === 'variable_name') {
        out.push(n);
        return;
      }
      // Keyed (`"x" => $e`) entries and nested lists descend; non-variable keys
      // (the string/int key) are not lvalues and carry no `variable_name`.
      for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i);
        if (c) walk(c);
      }
    };
    for (let i = 0; i < list.namedChildCount; i++) {
      const c = list.namedChild(i);
      if (c) walk(c);
    }
    return out;
  }

  /**
   * The bound variable(s) of a `foreach ($it as [$k =>] $v)`: the value (and key)
   * `variable_name`s. The structure is positional — the FIRST named child is the
   * iterable, then either a bare `variable_name` (value) or a `pair` ($k => $v).
   */
  private foreachTargets(stmt: SyntaxNode): SyntaxNode[] {
    const out: SyntaxNode[] = [];
    // Skip the iterable (first named child); collect value / pair targets after.
    for (let i = 1; i < stmt.namedChildCount; i++) {
      const c = stmt.namedChild(i);
      if (!c) continue;
      if (c.type === 'variable_name') out.push(c);
      else if (c.type === 'pair') {
        for (let j = 0; j < c.namedChildCount; j++) {
          const v = c.namedChild(j);
          if (v?.type === 'variable_name') out.push(v);
        }
      }
      // `body` (compound_statement / colon_block) is not a target — it has its
      // own non-variable_name/non-pair type, so it is skipped here.
    }
    return out;
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
   * Def-ONLY facts for a value-position assignment carrier (`$x = match($v) {…}`,
   * #2207): just the LHS target(s), attached to the continuation block the match
   * arms rejoin. The match condition + arm-value USES are already harvested onto
   * the branch's own blocks (visitMatch), so this must NOT re-walk the RHS. A
   * member/subscript target (`$this->x = match …`) has no scalar def → undefined.
   */
  assignmentDefFacts(assignExpr: SyntaxNode): StatementFacts | undefined {
    const acc = new FactAccumulator(assignExpr.startPosition.row + 1);
    const left = assignExpr.childForFieldName('left');
    if (left) {
      const lv = this.unwrapParen(left);
      if (lv.type === 'variable_name') this.def(lv, acc);
      else if (lv.type === 'list_literal') for (const v of this.listTargets(lv)) this.def(v, acc);
    }
    return acc.defCount() ? acc.finish() : undefined;
  }

  /** Facts for a `foreach ($it as [$k =>] $v)` head: targets bind, iterable used. */
  foreachHeadFacts(stmt: SyntaxNode): StatementFacts {
    const acc = new FactAccumulator(stmt.startPosition.row + 1);
    const iterable = stmt.namedChild(0);
    if (iterable) this.walkValue(iterable, acc);
    for (const v of this.foreachTargets(stmt)) this.def(v, acc);
    return acc.finish();
  }

  /** ENTRY-block facts for the function's parameters (defs only). */
  paramFacts(): StatementFacts | undefined {
    const acc = new FactAccumulator(this.fnNode.startPosition.row + 1);
    const params = this.fnNode.childForFieldName('parameters');
    if (params) {
      for (let i = 0; i < params.namedChildCount; i++) {
        const p = params.namedChild(i);
        if (!p) continue;
        if (
          p.type !== 'simple_parameter' &&
          p.type !== 'variadic_parameter' &&
          p.type !== 'property_promotion_parameter'
        ) {
          continue;
        }
        const varName = this.paramVarName(p);
        if (varName) this.def(varName, acc);
      }
    }
    // A closure's `use (...)` captures are live on entry too — model as defs.
    if (this.fnNode.type === 'anonymous_function') {
      const clause = this.fnNode.namedChildren.find(
        (c) => c.type === 'anonymous_function_use_clause',
      );
      if (clause) for (const v of this.useClauseVars(clause)) this.def(v, acc);
    }
    return acc.defCount() ? acc.finish() : undefined;
  }

  /** Def fact for a `catch (T $e)` parameter — prepend to the handler entry block. */
  catchParamFacts(catchClause: SyntaxNode): StatementFacts | undefined {
    const name = catchClause.childForFieldName('name');
    if (!name || name.type !== 'variable_name') return undefined;
    const acc = new FactAccumulator(catchClause.startPosition.row + 1);
    this.def(name, acc);
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

  /** Strip parenthesized wrappers around an lvalue (`($x) = 1`). */
  private unwrapParen(node: SyntaxNode): SyntaxNode {
    let n = node;
    let hops = 8;
    while (n.type === 'parenthesized_expression' && hops-- > 0) {
      const inner = n.namedChildren.find((c) => c.type !== 'comment');
      if (!inner) break;
      n = inner;
    }
    return n;
  }

  /** Value-position walk: collect uses; route def positions to the lvalue handler. */
  private walkValue(node: SyntaxNode, acc: FactAccumulator): void {
    const t = node.type;
    if (NESTED_FUNCTION_TYPES.has(t) && node.id !== this.fnId) {
      // Opaque nested function / closure — captured reads/writes are invisible.
      return;
    }

    switch (t) {
      case 'variable_name':
        this.use(node, acc);
        return;
      case 'assignment_expression': {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (left) {
          const lv = this.unwrapParen(left);
          if (lv.type === 'variable_name') {
            const snap = acc.defSnapshot();
            this.def(lv, acc);
            if (right) this.registerResultDefs(right, acc.defsSince(snap));
          } else if (lv.type === 'list_literal') {
            // Destructure: every target binds; non-variable keys are uses.
            for (const v of this.listTargets(lv)) this.def(v, acc);
          } else {
            this.walkValue(lv, acc); // member / subscript target — uses only
          }
        }
        if (right) this.walkValue(right, acc);
        return;
      }
      case 'augmented_assignment_expression': {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (left) {
          const lv = this.unwrapParen(left);
          if (lv.type === 'variable_name') {
            this.def(lv, acc);
            this.use(lv, acc); // compound assign reads too
          } else {
            this.walkValue(lv, acc);
          }
        }
        if (right) this.walkValue(right, acc);
        return;
      }
      case 'update_expression': {
        const arg = node.childForFieldName('argument');
        const lv = arg ? this.unwrapParen(arg) : null;
        if (lv?.type === 'variable_name') {
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
          if (op === '&&' || op === '||' || op === '??' || op === 'and' || op === 'or') {
            this.conditional(() => this.walkValue(right, acc));
          } else {
            this.walkValue(right, acc);
          }
        }
        return;
      }
      case 'conditional_expression': {
        const cond = node.childForFieldName('condition');
        const body = node.childForFieldName('body');
        const alt = node.childForFieldName('alternative');
        if (cond) this.walkValue(cond, acc);
        if (body) this.conditional(() => this.walkValue(body, acc));
        if (alt) this.conditional(() => this.walkValue(alt, acc));
        return;
      }
      case 'function_call_expression':
        this.visitCall(node, acc, 'function');
        return;
      case 'member_call_expression':
      case 'nullsafe_member_call_expression':
        this.visitCall(node, acc, 'member');
        return;
      case 'scoped_call_expression':
        this.visitCall(node, acc, 'scoped');
        return;
      case 'object_creation_expression':
        this.visitNew(node, acc);
        return;
      case 'member_access_expression':
      case 'nullsafe_member_access_expression': {
        // `$o->p` — value read of the object root only (the property name is not
        // a scalar binding); record the innermost identifier-rooted member read.
        this.walkChain(node, acc);
        return;
      }
      default:
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (c) this.walkValue(c, acc);
        }
    }
  }

  // ── taint-site harvest ───────────────────────────────────────────────────

  /**
   * When `value`'s root (after stripping parens) is a call / object-creation
   * node, remember its site should carry `resultDefs: defs`.
   */
  private registerResultDefs(value: SyntaxNode, defs: readonly number[]): void {
    if (defs.length === 0) return;
    const root = this.unwrapParen(value);
    if (
      root.type === 'function_call_expression' ||
      root.type === 'member_call_expression' ||
      root.type === 'nullsafe_member_call_expression' ||
      root.type === 'scoped_call_expression' ||
      root.type === 'object_creation_expression'
    ) {
      this.resultDefTargets.set(root.id, [...defs]);
    }
  }

  /**
   * Call-site handler for the three PHP call shapes:
   *  - `function`: `function_call_expression` (`function` field = name, no receiver)
   *  - `member`:   `member_call_expression` (`object` receiver, `name` method)
   *  - `scoped`:   `scoped_call_expression` (`scope` class, `name` method)
   * Reproduces the same uses the default descent recorded plus the call site.
   */
  private visitCall(
    node: SyntaxNode,
    acc: FactAccumulator,
    shape: 'function' | 'member' | 'scoped',
  ): void {
    const argsNode = node.childForFieldName('arguments');
    // `node` IS the call expression — the SAME node the scope-extractor anchors
    // `@reference.call.*` (its `atRange`) on (KTD7).
    const siteIdx = acc.openCallSite('call', [
      node.startPosition.row + 1,
      node.startPosition.column,
    ]);
    acc.pushFrame(siteIdx);

    if (shape === 'function') {
      const fnNode = node.childForFieldName('function');
      if (fnNode) {
        if (fnNode.type === 'name' || fnNode.type === 'qualified_name') {
          acc.setSiteCallee(siteIdx, fnNode.text);
        } else {
          // dynamic callee (`$fn()`, `($obj->cb)()`) — record uses, no static path
          this.walkValue(fnNode, acc);
        }
      }
    } else if (shape === 'member') {
      const objectNode = node.childForFieldName('object');
      const nameNode = node.childForFieldName('name');
      let receiverPath: string | undefined;
      if (objectNode) {
        const chain = this.walkChain(objectNode, acc);
        receiverPath = chain.path;
        if (chain.rootIdx !== undefined) acc.setSiteReceiver(siteIdx, chain.rootIdx);
      }
      if (nameNode && nameNode.type === 'name') {
        const callee =
          receiverPath !== undefined ? `${receiverPath}.${nameNode.text}` : nameNode.text;
        acc.setSiteCallee(siteIdx, callee);
      }
    } else {
      // scoped: `C::method(...)` — scope is a class name (not a binding).
      const scopeNode = node.childForFieldName('scope');
      const nameNode = node.childForFieldName('name');
      const scopeText =
        scopeNode && (scopeNode.type === 'name' || scopeNode.type === 'qualified_name')
          ? scopeNode.text
          : undefined;
      if (nameNode && nameNode.type === 'name') {
        const callee = scopeText !== undefined ? `${scopeText}.${nameNode.text}` : nameNode.text;
        acc.setSiteCallee(siteIdx, callee);
      }
    }

    const resultDefs = this.resultDefTargets.get(node.id);
    if (resultDefs !== undefined) acc.setSiteResultDefs(siteIdx, resultDefs);
    this.walkArgs(argsNode, acc);
    acc.popFrame();
  }

  /** Explicit `object_creation_expression` (`new Foo($x)`) handler. */
  private visitNew(node: SyntaxNode, acc: FactAccumulator): void {
    const argsNode = node.childForFieldName('arguments');
    // `node` IS the object_creation_expression — the SAME node the
    // scope-extractor anchors `@reference.call.constructor` (its `atRange`) on.
    const siteIdx = acc.openCallSite('new', [
      node.startPosition.row + 1,
      node.startPosition.column,
    ]);
    acc.pushFrame(siteIdx);
    // The class name is the first `name`/`qualified_name` child (not a binding).
    const className = node.namedChildren.find(
      (c) => c.type === 'name' || c.type === 'qualified_name',
    );
    if (className) acc.setSiteCallee(siteIdx, className.text.replace(/\s+/g, ''));
    const resultDefs = this.resultDefTargets.get(node.id);
    if (resultDefs !== undefined) acc.setSiteResultDefs(siteIdx, resultDefs);
    this.walkArgs(argsNode, acc);
    acc.popFrame();
  }

  /** Walk an `arguments` node, tagging each positional `argument` for occurrences. */
  private walkArgs(argsNode: SyntaxNode | null, acc: FactAccumulator): void {
    if (!argsNode) return;
    let pos = 0;
    for (let i = 0; i < argsNode.namedChildCount; i++) {
      const arg = argsNode.namedChild(i);
      if (!arg || arg.type === 'comment') continue;
      if (arg.type !== 'argument') {
        // A spread (`...$xs`) or other non-`argument` child — still walk for uses.
        this.walkValue(arg, acc);
        continue;
      }
      acc.setFrameArg(pos);
      this.walkValue(arg, acc);
      pos++;
    }
  }

  /**
   * Member-access chain walk shared by value position and a method-call receiver.
   * Records the chain-root `variable_name` as a use plus at most ONE member-read
   * site — the innermost access — when the root is a variable.
   */
  private walkChain(node: SyntaxNode, acc: FactAccumulator): { path?: string; rootIdx?: number } {
    const accesses: string[] = [];
    let cur: SyntaxNode = this.unwrapParen(node);
    for (;;) {
      if (
        cur.type === 'member_access_expression' ||
        cur.type === 'nullsafe_member_access_expression'
      ) {
        const field = cur.childForFieldName('name');
        accesses.unshift(field?.text ?? '');
        const obj = cur.childForFieldName('object');
        if (!obj) break;
        cur = this.unwrapParen(obj);
      } else {
        break;
      }
    }
    let rootIdx: number | undefined;
    let rootSegment: string | undefined;
    if (cur.type === 'variable_name') {
      rootIdx = this.resolve(cur);
      acc.addUse(rootIdx);
      rootSegment = cur.text;
    } else {
      this.walkValue(cur, acc);
    }
    const innermost = accesses[0];
    if (rootIdx !== undefined && innermost) acc.addMemberRead(rootIdx, innermost);
    const path =
      rootSegment !== undefined && accesses.every((a) => a !== '')
        ? [rootSegment, ...accesses].join('.')
        : undefined;
    return { path, rootIdx };
  }
}

/**
 * Ordered, deduplicating def/use + call-site collector for one statement record.
 * The shared {@link CallSiteFactAccumulator} carries the def/use machinery plus
 * the taint-site harvest.
 */
const FactAccumulator = CallSiteFactAccumulator;
