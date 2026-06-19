/**
 * CFG data model — plain, JSON-serializable types (issue #2081, M1).
 *
 * These cross the worker→main boundary and the disk-backed/durable ParsedFile
 * store, so they must contain NO tree-sitter AST references, class instances,
 * or anything that does not survive `JSON.stringify` → `JSON.parse`. Block and
 * edge endpoints are referenced by integer index within a function's CFG.
 *
 * The per-language `CfgVisitor` (built in the parse worker, where the AST
 * lives — see the M1 plan KTD1/KTD7) produces a `FunctionCfg` per function; the
 * array of them is what rides on `ParsedFile.cfgSideChannel`.
 */

/**
 * One distinct declared variable (binding) within a function (#2082 M2 U1).
 *
 * Statement facts reference bindings by integer index into
 * {@link FunctionCfg.bindings} — names appear once per binding instead of once
 * per occurrence (measured ~4× smaller serialized payload than named records).
 * Distinct bindings of the same name (shadowing) get distinct entries, which is
 * what keeps an inner `let x` from falsely killing the outer `x`'s definitions
 * in the reaching-defs solver. NOTE: no field here may be named `nodeId` — the
 * durable parsedfile-store reviver dedups objects keyed on that field name.
 */
export interface BindingEntry {
  /** Source-level variable name (what the persisted edge's `reason` carries). */
  readonly name: string;
  /**
   * 1-based line/0-based column of the canonical declaration site — `var`
   * multi-declarations canonicalize to the FIRST declaration in source order.
   * Both 0 for synthetic bindings.
   */
  readonly declLine: number;
  readonly declColumn: number;
  /** How the binding was introduced (param/catch matter to the M3 taint pass). */
  readonly kind: 'var' | 'let' | 'const' | 'param' | 'catch' | 'function' | 'class' | 'module';
  /**
   * True when the name has no in-function declaration site (implicit global,
   * import, or a variable captured from an enclosing function) — keyed
   * `name@module` in edge ids instead of `name:line:col`.
   */
  readonly synthetic?: boolean;
  /**
   * For `kind: 'param'` bindings only: the 0-based ENCLOSING TOP-LEVEL FORMAL
   * position this binding belongs to — the index a call site's argument position
   * joins against (PDG FU-C). For a simple identifier formal this equals the
   * param's ordinal; for a DESTRUCTURED/REST formal every inner name carries the
   * SAME formal index (`function f({a, b}, c)` ⇒ a:0, b:0, c:1), so a downstream
   * positional consumer never mistakes the destructured-object formal for a later
   * simple formal. Set by the per-language `declareParams`; OMITTED when the
   * producer does not (yet) supply it — a consumer that needs a sound formal
   * position MUST treat a param binding without `formalIndex` as unknown and fall
   * back conservatively (never attribute a flattened ordinal to a formal slot).
   * Omit-when-absent (pre-upgrade durable channels stay valid; JSON-plain).
   */
  readonly formalIndex?: number;
}

/**
 * One occurrence of a binding inside a call/new site's argument position
 * (#2083 M3 U1). A bare `number` is a DIRECT occurrence (binding index into
 * {@link FunctionCfg.bindings}); a `[bindingIdx, viaSiteIdx]` tuple marks an
 * occurrence that reaches this argument THROUGH the nested site at
 * `viaSiteIdx` (an index into the SAME statement's {@link StatementFacts.sites}
 * array). The tag is load-bearing for sanitizer interposition (plan KTD4a):
 * a flat per-arg binding set cannot distinguish `exec(escape(x))` (kill) from
 * `exec(x)` (finding) — the single most common safe pattern would
 * false-positive without it.
 */
export type SiteArgOccurrence = number | readonly [number, number];

/**
 * One call site, constructor call, or value-position member read harvested
 * from a statement (#2083 M3 U1, plan KTD2). Worker-side substrate for the M3
 * taint pass: the M2 facts carry no expression structure, and the main thread
 * cannot re-parse (the #1983 OOM shape). Spec-AGNOSTIC — records structure
 * only, never source/sink/sanitizer-ness (matching is a main-thread concern).
 *
 * Integer indices: binding fields (`receiver`/`object`/`resultDefs`/arg
 * occurrences) index {@link FunctionCfg.bindings}; site references (`parent`,
 * via-tags) index the OWNING statement's `sites` array. JSON-plain; NO field
 * here may be named `nodeId` (durable parsedfile-store reviver hazard — see
 * {@link BindingEntry}).
 */
export interface SiteRecord {
  readonly kind: 'call' | 'new' | 'member-read';
  /**
   * Dotted callee path for call/new sites whose callee chain is rooted at an
   * identifier/`this`/`super` (`child_process.exec`, `req.body.toString`).
   * Optional chaining is normalized (`a?.b()` ⇒ `a.b`); string-literal
   * subscripts fold into the path (`cp["exec"]` ⇒ `cp.exec`). Absent when the
   * chain is not statically resolvable (dynamic key, call-rooted chain).
   */
  readonly callee?: string;
  /**
   * Binding index of the callee chain's ROOT identifier when the callee is a
   * member chain (`userInput.trim()` ⇒ `userInput`). Method calls launder
   * taint without it (plan KTD5 receiver-position TITO). Absent for bare
   * calls (`exec(x)`) and non-identifier roots.
   */
  readonly receiver?: number;
  /**
   * Per-argument-position occurrence entries (trailing empty positions are
   * trimmed; absent when no argument carries a binding occurrence). For
   * `template: true` sites every substitution occurrence aggregates at
   * position 0 (tagged templates have no positional argument list).
   */
  readonly args?: ReadonlyArray<readonly SiteArgOccurrence[]>;
  /**
   * Bindings defined by a declarator/assignment whose ENTIRE value (after
   * unwrapping parens/`await`/`as`/`!`) is this call — `const b = escape(t)`
   * ⇒ `[b]`. Per-declarator: `const a = t, b = escape(t)` attaches `[b]`
   * only. Kill placement (KTD4b) keys on this: a sanitizer kills exactly the
   * defs that receive its result directly.
   */
  readonly resultDefs?: readonly number[];
  /**
   * `[siteIdx, argIdx]` of the innermost enclosing call/new site argument
   * position this site occurs in (`exec(escape(x))` ⇒ escape's parent is
   * `[execSiteIdx, 0]`). Absent for top-level sites.
   */
  readonly parent?: readonly [number, number];
  /**
   * Index of the FIRST spread argument (`exec(...args)` ⇒ 0). Presence means
   * position matching must degrade soundly (any sink position ≥ this index —
   * plan KTD2/U2). A number (not boolean) because the matcher needs the index.
   */
  readonly spread?: number;
  /** Tagged-template call (`sql\`…${id}\``) — argument positions are not positional. */
  readonly template?: boolean;
  /**
   * String-literal first argument when the callee is bare `require` —
   * CommonJS aliases resolve like ESM imports on the main thread (KTD7).
   */
  readonly requireArg?: string;
  /** Member read: binding index of the object root (`req.body` ⇒ `req`). */
  readonly object?: number;
  /**
   * Member read: property name (`req.body` ⇒ `'body'`; `req["body"]`
   * included; dynamic `req[key]` is never recorded — documented KTD10 FN).
   */
  readonly property?: string;
  /**
   * Call-site anchor source position `[line (1-based), column (0-based)]` for
   * call/new sites only — member-read sites omit it (the resolved-id join only
   * consumes call/new). Recorded by the harvester at the call/new node where it
   * reads the callee, so the later resolved-callee-id join inherits this
   * harvester's exact (nested-function-excluded — see line 150) site
   * partitioning (#2227 follow-up plan KTD1).
   *
   * ANCHOR ALIGNMENT (plan KTD7 — load-bearing): this MUST be the SAME position
   * the CALLS-edge resolution keys its `atRange` on, because a downstream unit
   * joins the two by EXACT position. That anchor is the WHOLE call/new
   * expression node's start — `nodeToCapture('@reference.call.*', node)` in the
   * scope-extractor anchors `@reference.call.free/.member/.constructor` on the
   * `call_expression`/`new_expression` (TS) / `method_invocation`/
   * `object_creation_expression` (Java) node itself (the callee identifier /
   * member property is the `@reference.name` SUB-tag, never the anchor — see
   * `anchorCaptureFor` + `KNOWN_SUB_TAGS` in scope-extractor.ts, and
   * `atRange: anchor.range` at scope-extractor.ts:1030). So for a bare call
   * `foo(x)`, a member call `arr.map(x)`, and a namespaced/chained call
   * `a.b.c(x)` alike, `at` is the start of the enclosing call/new expression
   * node — the harvester's `visitCall`/`visitNew` receives exactly that node and
   * records `[node.startPosition.row + 1, node.startPosition.column]`. (For a
   * member call the call expression starts at the receiver, e.g. `arr` in
   * `arr.map(x)`, and the CALLS anchor starts there too — they match.)
   *
   * Omit-when-absent (pre-upgrade durable channels stay valid; JSON-plain; NOT
   * named `nodeId` per the reviver hazard above).
   */
  readonly at?: readonly [number, number];
}

/**
 * Def/use facts for one harvested statement (or construct header), in
 * execution order within its block (#2082 M2 U1). `defs`/`uses` are indices
 * into {@link FunctionCfg.bindings}. A compound assignment / update expression
 * lists its binding in BOTH. Self-describing — `line` is carried here, never
 * inferred from the block's text fragments (facts-only records exist, e.g.
 * params on ENTRY and catch params).
 *
 * `mayDefs` (tri-review P1): defs harvested inside CONDITIONALLY-EVALUATED
 * subexpressions — short-circuit right operands (`a && (x = v)`,
 * `c ?? (c = load())`), ternary arms, logical-assignment operators, and
 * switch case-test expressions. The solver treats them as GEN WITHOUT KILL:
 * treating them as must-defs would falsely kill the prior def on the
 * not-taken path (a taint false negative on core JS idioms). Optional —
 * absent means none.
 *
 * `sites` (#2083 M3 U1): call/member-read structure for the taint pass —
 * see {@link SiteRecord}. Optional and omit-when-empty; absent on pre-M3
 * channels and on statements with no calls or member reads. Sites inside
 * nested functions are NOT recorded (consistent with def/use invisibility —
 * the enclosing `arr.forEach(...)` call IS, with receiver `arr`).
 */
export interface StatementFacts {
  readonly line: number;
  readonly defs: readonly number[];
  readonly uses: readonly number[];
  readonly mayDefs?: readonly number[];
  readonly sites?: readonly SiteRecord[];
}

/** A basic block: a maximal straight-line run of statements between leaders. */
export interface BasicBlockData {
  /** Block index within its function. The synthetic ENTRY is always 0. */
  readonly index: number;
  readonly startLine: number;
  readonly endLine: number;
  /** Source snippet for the block (empty for synthetic ENTRY/EXIT). */
  readonly text: string;
  readonly kind: 'entry' | 'exit' | 'normal';
  /**
   * Per-statement def/use facts in execution order (#2082 M2 U1). Present only
   * when the producing visitor harvests (TS/JS under `--pdg`); absent on
   * hand-built or pre-M2 CFGs — the reaching-defs solver reports `no-facts`.
   */
  readonly statements?: readonly StatementFacts[];
}

/**
 * Why one block flows to another — drives the `reason` on the emitted CFG edge.
 *
 * Kind invariant (M2): a bare jump kind (`return`/`break`/`continue`) means the
 * SOURCE block's terminator is that jump statement. A `finally-*` kind marks a
 * COMPLETION edge out of a `finally` body's exit — the leg that resumes a jump
 * which was re-routed through the finally (issue #2082 U2). Reusing the bare
 * kinds on completion edges would silently break consumers that infer the
 * source block's terminator from the kind, and a single generic kind would lose
 * WHICH jump each completion edge completes when a shared finally has several
 * pending targets.
 */
export type CfgEdgeKind =
  | 'seq' // straight-line fallthrough
  | 'cond-true' // branch taken (if/while/for condition true)
  | 'cond-false' // branch not taken / loop exit
  | 'loop-back' // back-edge to a loop header
  | 'break' // break → loop/switch exit (or the finally it must cross)
  | 'continue' // continue → loop header (or the finally it must cross)
  | 'return' // return → function EXIT (or the finally it must cross)
  | 'throw' // throw → nearest handler / finally / EXIT
  | 'switch-case' // dispatch to a case
  | 'fallthrough' // switch case → next case (no break)
  | 'finally-return' // finally exit → resumed return target (EXIT / outer finally)
  | 'finally-break' // finally exit → resumed break target
  | 'finally-continue'; // finally exit → resumed continue target

export interface CfgEdgeData {
  readonly from: number;
  readonly to: number;
  readonly kind: CfgEdgeKind;
}

/** One function's control-flow graph. `cfgSideChannel` is `readonly FunctionCfg[]`. */
export interface FunctionCfg {
  readonly filePath: string;
  /** Source span of the owning function — anchors the BasicBlock node ids. */
  readonly functionStartLine: number;
  readonly functionEndLine: number;
  /**
   * Start COLUMN of the owning function. Combined with `functionStartLine` it
   * disambiguates the BasicBlock node ids when two functions share a start line
   * — e.g. `{ a: () => x(), b: () => y() }`, where both arrows begin on the same
   * line and each restarts its block indices at 0. Without the column the ids
   * collide and the graph's first-writer-wins `addNode` silently drops the
   * second function's blocks and cross-wires its edges.
   */
  readonly functionStartColumn: number;
  readonly entryIndex: number;
  readonly exitIndex: number;
  readonly blocks: readonly BasicBlockData[];
  readonly edges: readonly CfgEdgeData[];
  /**
   * The function's binding table (#2082 M2 U1) — referenced by index from
   * {@link BasicBlockData.statements}. Present iff statement facts are.
   */
  readonly bindings?: readonly BindingEntry[];
}

/**
 * Per-language CFG strategy. Invoked **in the parse worker** for each function
 * node. `TNode` is the language's AST node type (tree-sitter `SyntaxNode` for
 * TS/JS) — kept generic so this module stays AST-library-agnostic. Returns
 * `undefined` when the node is not a CFG-bearing function (the caller skips it).
 */
export interface CfgVisitor<TNode = unknown> {
  buildFunctionCfg(fnNode: TNode, filePath: string): FunctionCfg | undefined;

  /**
   * Whether `node` is a CFG-bearing function this visitor handles. Lets the
   * worker enumerate functions (and apply the per-function line budget) by a
   * cheap node-type test, instead of attempting to build a CFG for every AST
   * node. `buildFunctionCfg` still re-checks, so this is purely an optimization
   * + the seam the line-budget hooks into.
   */
  isFunction(node: TNode): boolean;
}
