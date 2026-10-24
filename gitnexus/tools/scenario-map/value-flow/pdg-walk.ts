/**
 * Static value-flow check of the scenario map (U10, R9, KTD11, design §5.3a steps 1–3): for each
 * facet-equal candidate pair whose discarded values differ, the test side (bind.ts), the checker
 * (checker.ts) and a stitched inter-procedural walk over the GitNexus PDG give `clean`, `veto` or
 * `unknown` with reasons. A veto or an unknown sends the pair to Review (R9); a pair whose
 * discarded values are equal is `not-required`.
 *
 * The walk (KTD11 conflict call-out: `pdg_query` flows are intra-procedural, lose the def/use
 * lines and cap file-wide queries, so the walk is stitched here):
 *  1. per function, the REACHING_DEF edges whose source block id starts with
 *     `BasicBlock:<file>:<fnLine>:` (the emit template `BasicBlock:<file>:<fnLine>:<fnCol>:<n>`,
 *     src/core/ingestion/cfg/emit.ts; `<file>` relative to the indexed root, `fnLine` 1-based,
 *     `fnCol` the 0-based column of the function node, which is Babel's) are read through
 *     LocalBackend's cypher implementation ({@link openLocalBackendEdgeSource}) and decoded with
 *     `decodeReachingDefReason` into (binding, defLine → useLine) pairs; parameters are defined
 *     on the signature's lines, and every other def of a tracked name must be the binding's
 *     declaration or one of its assignments (else unknown: references are never skipped on a
 *     line mapping that does not hold);
 *  2. every reference of a tracked binding on a use line its def reaches is climbed to its
 *     consumers and classified (sinks.ts `walkUp`; the statement rule: any opaque or unknown use
 *     vetoes the statement);
 *  3. a binding derived from the value (`const { ratio } = opts`, `x = v`, `v += 1`, a container
 *     the value was stored into) is walked under its own name, from its own def lines; a store
 *     into a property or module state is unknown;
 *  4. repo code is a clean sink only inside the pair's mutated production files (KTD7);
 *  5. the checker resolves each callee, and the argument position in the production AST gives
 *     the parameter the walk recurses into; when the callee returns the value (its own walk
 *     reaches a `return`, or its CALL_SUMMARY lists the parameter: `decodeCallSummary`), the walk
 *     continues with the call's result in the caller;
 *  6. a truncated function query (as many rows as the per-function REACHING_DEF cap of the
 *     index), an ambiguous binding (two bindings of one name in a function: the edge reason only
 *     carries the name), a reference the PDG reports no use for, a value captured by a closure,
 *     recursion and the depth cap ({@link DEPTH_CAP} functions, entry included) are unknown.
 *
 * Gates, run-level `degraded` flags (every flag goes to the report's completeness block):
 *  - `no-pdg-layer`: `pdgLayerStatus` (src/mcp/local/pdg-impact.ts) is not `ready` (no layer,
 *    unreadable meta, or a sub-layer missing); every value-differing pair is vetoed;
 *  - `checker-version`: `typescript` is not exactly 7.0.2 (checker.ts); every value-differing pair
 *    is unknown; `checker-unavailable`: the checker failed to open; same.
 * Entry checks: an entry that does not resolve to a repo function of the mutated files, whose
 * parameter has no resolvable type, or whose parameter is typed `any` or `unknown`, is unknown;
 * literal-union and enum members of the entry parameter are recorded for the reviewer.
 *
 * Outputs per pair: status, reasons (opaque and unknown sinks with their location, entry
 * problems, bind reasons, degraded flags), the entries with their declaration and parameter, every
 * sink with its call depth, and `opaqueSinks`, the opaque call sites for the trace's wrap list
 * (U11).
 *
 * Real edge source: {@link openLocalBackendEdgeSource} constructs `LocalBackend` and reads the
 * edges with `executeCypher`, the public entry of the backend's `cypher` tool implementation (the
 * `callTool('cypher')` route formats rows as a markdown table, which splits the `|` inside every
 * REACHING_DEF reason). LadybugDB captures stdout, so CLIs that use it write with `writeSync(1, …)`.
 * Unit tests inject a fake {@link PdgEdgeSource}.
 *
 * Library only; the scenario-map CLI (U14) runs {@link staticValueFlow} once per run.
 */
import path from 'node:path';
import { parse } from '@babel/parser';
import traverse, { type Binding, type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { decodeReachingDefReason } from '../../../src/core/ingestion/cfg/reaching-def-reason-codec.js';
import { decodeCallSummary } from '../../../src/core/ingestion/taint/call-summary-codec.js';
import { scanSupportedTables } from '../mutation/row-deletion.js';
import { bindPair, type BindSide, type EntryKind } from './bind.js';
import type { OpenCheckerResult, ParamInfo, ValueFlowChecker } from './checker.js';
import {
  statementOf,
  walkUp,
  type CalleeInfo,
  type ClassifyContext,
  type Sink,
  type SinkLocation,
  type TableSupport,
  type WalkUpResult,
} from './sinks.js';

/** Functions walked per entry, the entry included (KTD11 rule 6). */
export const DEPTH_CAP = 4;
/** REACHING_DEF cap per function when the index does not record one (emit.ts default). */
export const DEFAULT_REACHING_DEF_CAP = 4000;

export type PdgLayerState = 'ready' | 'no-layer' | 'sub-layer-missing' | 'unknown';
export type DegradedFlag = 'checker-version' | 'checker-unavailable' | 'no-pdg-layer';

/** One persisted REACHING_DEF edge: block ids and the encoded reason. */
export interface RdEdge {
  src: string;
  dst: string;
  reason: string;
}

/** Where the walk reads the PDG; paths are relative to the indexed root. */
export interface PdgEdgeSource {
  layerState(): Promise<PdgLayerState>;
  /** REACHING_DEF edges whose source id starts with `BasicBlock:<file>:<fnLine>:`. */
  reachingDefs(file: string, fnLine: number): Promise<{ edges: RdEdge[]; truncated: boolean }>;
  /** Return-flow parameters of the function `name` starting on 1-based `line`; null: none. */
  callSummary(file: string, line: number, name: string): Promise<number[] | null>;
}

export interface ValueFlowPair {
  /** Phase 0 ids. */
  a: string;
  b: string;
  sides: [BindSide, BindSide];
  /** The pair's mutate scope (KTD7): repo paths of whole production files. */
  mutate: readonly string[];
}

export interface EntryRecord {
  position: number;
  kind: EntryKind;
  callee: string;
  argIndex: number;
  path: string[];
  /** `<repo path>#<name>` of the resolved declaration; null when it did not resolve to repo code. */
  declaration: string | null;
  param: ParamInfo | null;
}

export interface DepthSink extends Sink {
  /** 1 for the entry function. */
  depth: number;
}

export interface OpaqueSite {
  file: string;
  line: number;
  column: number;
  callee: string;
}

export interface PairValueFlow {
  a: string;
  b: string;
  status: 'clean' | 'veto' | 'unknown' | 'not-required';
  /** Sorted, distinct. */
  reasons: string[];
  entries: EntryRecord[];
  sinks: DepthSink[];
  opaqueSinks: OpaqueSite[];
  /** The run-level flags (they apply to every pair). */
  degraded: DegradedFlag[];
}

export interface StaticValueFlowRun {
  degraded: DegradedFlag[];
  checker: { version: string | null; tsconfig: string | null; error: string | null };
  pdgLayer: PdgLayerState;
  pairs: PairValueFlow[];
}

export interface StaticValueFlowOptions {
  /** Text of a repo path; null when unreadable. */
  read: (repoPath: string) => string | null;
  /** Repo path of the indexed root with a trailing `/` (`''` when the repo itself is indexed). */
  indexPrefix: string;
  edges: PdgEdgeSource;
  checker: OpenCheckerResult;
  depthCap?: number;
}

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0];
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ── Modules ────────────────────────────────────────────────────────────────

interface ModuleInfo {
  file: string;
  /** Node paths by end offset. */
  byEnd: Map<number, NodePath[]>;
  tables: ReadonlyMap<string, TableSupport>;
}

const PLUGINS: ['typescript', 'decorators-legacy'] = ['typescript', 'decorators-legacy'];

function loadModule(file: string, source: string): ModuleInfo | null {
  try {
    const ast = parse(source, { sourceType: 'module', plugins: PLUGINS });
    const byEnd = new Map<number, NodePath[]>();
    traverse(ast, {
      enter(nodePath) {
        const end = nodePath.node.end;
        if (end === null || end === undefined) return;
        const list = byEnd.get(end) ?? [];
        list.push(nodePath);
        byEnd.set(end, list);
      },
    });
    const tables = new Map<string, TableSupport>();
    for (const [binding, constructs] of scanSupportedTables(file, source) ?? new Map()) {
      tables.set(binding, { supported: constructs.length === 0, constructs });
    }
    return { file, byEnd, tables };
  } catch {
    return null;
  }
}

/** The function a declaration ending at `end` declares, else why not. */
function findFunction(
  module: ModuleInfo,
  end: number | null,
  isClass: boolean,
): NodePath<t.Function> | string {
  if (end === null) return 'no declaration offset';
  for (const candidate of module.byEnd.get(end) ?? []) {
    if (isClass && (candidate.isClassDeclaration() || candidate.isClassExpression())) {
      const ctor = candidate
        .get('body')
        .get('body')
        .find((member) => member.isClassMethod({ kind: 'constructor' }));
      return ctor !== undefined && ctor.isFunction() ? ctor : 'class without a constructor';
    }
    if (candidate.isFunction()) return candidate;
    if (candidate.isVariableDeclarator() || candidate.isClassProperty()) {
      const value = candidate.isVariableDeclarator()
        ? candidate.get('init')
        : (candidate as NodePath<t.ClassProperty>).get('value');
      if (!Array.isArray(value) && value.isFunction()) return value;
    }
    if (candidate.isObjectProperty()) {
      const value = candidate.get('value');
      if (value.isFunction()) return value;
    }
  }
  return 'declaration not found in the module';
}

/** The function's own name, for CALL_SUMMARY: declaration id, declarator or key. */
function functionName(fn: NodePath<t.Function>): string {
  const node = fn.node;
  if ((t.isFunctionDeclaration(node) || t.isFunctionExpression(node)) && node.id) {
    return node.id.name;
  }
  if ((t.isClassMethod(node) || t.isObjectMethod(node)) && t.isIdentifier(node.key)) {
    return node.key.name;
  }
  const parent = fn.parent;
  if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) return parent.id.name;
  if ((t.isObjectProperty(parent) || t.isClassProperty(parent)) && t.isIdentifier(parent.key)) {
    return parent.key.name;
  }
  return '';
}

/** True when a reference sits inside a function nested in `fn`. */
function inNestedFunction(reference: NodePath, fn: NodePath<t.Function>): boolean {
  const owner = reference.getFunctionParent();
  return owner !== null && owner.node !== fn.node;
}

/** True when `fn` (outside nested functions) declares more than one binding named `name`. */
function ambiguousName(fn: NodePath<t.Function>, name: string): boolean {
  const bindings = new Set<Binding>();
  fn.traverse({
    Function(inner) {
      inner.skip();
    },
    Identifier(identifier) {
      if (identifier.node.name !== name) return;
      const binding = identifier.scope.getBinding(name);
      if (binding !== undefined && binding.scope.getFunctionParent()?.path.node === fn.node) {
        bindings.add(binding);
      }
    },
  });
  const own = fn.scope.getBinding(name);
  if (own !== undefined && own.scope.path.node === fn.node) bindings.add(own);
  return bindings.size > 1;
}

interface Span {
  start: number;
  end: number;
}

const within = (line: number, span: Span): boolean => line >= span.start && line <= span.end;

/** 1-based lines of the statement around a path (the path itself outside any statement). */
function spanOf(at: NodePath): Span {
  const statement = statementOf(at) ?? at;
  return { start: statement.node.loc?.start.line ?? 0, end: statement.node.loc?.end.line ?? 0 };
}

/** The signature's lines, where the PDG defines the parameters: function start to body start. */
function signatureSpan(fn: NodePath<t.Function>): Span {
  const start = fn.node.loc?.start.line ?? 0;
  return { start, end: fn.node.body.loc?.start.line ?? start };
}

/** Where a binding gets a value: its declaration (a parameter: the signature) and assignments. */
function defSpans(binding: Binding, fn: NodePath<t.Function>): Span[] {
  const declared = binding.kind === 'param' ? signatureSpan(fn) : spanOf(binding.path);
  return [declared, ...binding.constantViolations.map(spanOf)];
}

// ── The walk ───────────────────────────────────────────────────────────────

interface Tracked {
  name: string;
  binding: Binding | undefined;
  kind: 'value' | 'container';
  /** Def lines of the binding's value; null: every def (a container). */
  lines: { start: number; end: number } | null;
}

interface FunctionWalk {
  returns: boolean;
  /** The callee's CALL_SUMMARY return-flow params; null when none. */
  summary: number[] | null;
}

interface WalkEnv {
  read: (repoPath: string) => string | null;
  indexPrefix: string;
  edges: PdgEdgeSource;
  checker: ValueFlowChecker;
  depthCap: number;
  modules: Map<string, ModuleInfo | null>;
}

class PairWalker {
  readonly sinks: DepthSink[] = [];
  private readonly memo = new Map<string, FunctionWalk>();

  constructor(
    private readonly env: WalkEnv,
    private readonly inScope: (repoPath: string) => boolean,
  ) {}

  private module(file: string): ModuleInfo | null {
    if (!this.env.modules.has(file)) {
      const source = this.env.read(file);
      this.env.modules.set(file, source === null ? null : loadModule(file, source));
    }
    return this.env.modules.get(file) ?? null;
  }

  private indexPath(file: string): string | null {
    const prefix = this.env.indexPrefix;
    return file.startsWith(prefix) ? file.slice(prefix.length) : null;
  }

  private unknown(what: string, reason: string, at: SinkLocation, depth: number): void {
    this.sinks.push({ class: 'unknown', what, reason, location: at, depth });
  }

  /** Walks argument `argIndex` of a repo callee; `at` is the call site. */
  async walkFunction(
    callee: CalleeInfo,
    argIndex: number,
    depth: number,
    stack: readonly string[],
    at: SinkLocation,
  ): Promise<FunctionWalk> {
    const key = `${callee.file}#${callee.declarationEnd}#${argIndex}`;
    if (stack.includes(key)) {
      this.unknown(callee.name, 'recursion', at, depth);
      return { returns: false, summary: null };
    }
    const cached = this.memo.get(key);
    if (cached !== undefined) return cached;
    const result = await this.walkFunctionOnce(callee, argIndex, depth, [...stack, key], at);
    this.memo.set(key, result);
    return result;
  }

  private async walkFunctionOnce(
    callee: CalleeInfo,
    argIndex: number,
    depth: number,
    stack: readonly string[],
    at: SinkLocation,
  ): Promise<FunctionWalk> {
    const none: FunctionWalk = { returns: false, summary: null };
    const file = callee.file ?? '';
    const module = this.module(file);
    if (module === null) {
      this.unknown(callee.name, 'module unreadable or unparseable', at, depth);
      return none;
    }
    const fn = findFunction(module, callee.declarationEnd, callee.isClass);
    if (typeof fn === 'string') {
      this.unknown(callee.name, fn, at, depth);
      return none;
    }
    const fnLine = fn.node.loc?.start.line ?? 0;
    const fnColumn = fn.node.loc?.start.column ?? 0;
    const fnAt: SinkLocation = { file, line: fnLine, column: fnColumn };
    const indexFile = this.indexPath(file);
    if (indexFile === null) {
      this.unknown(callee.name, 'outside the indexed root', fnAt, depth);
      return none;
    }
    let summary: number[] | null = null;
    try {
      summary = await this.env.edges.callSummary(indexFile, fnLine, functionName(fn));
    } catch {
      summary = null;
    }
    const params = fn.node.params;
    const rest = params.findIndex((param) => t.isRestElement(param));
    if (rest !== -1 && rest <= argIndex) {
      this.unknown(callee.name, 'rest parameter', fnAt, depth);
      return { returns: false, summary };
    }
    if (argIndex >= params.length) {
      if (fn.scope.getBinding('arguments') === undefined && /\barguments\b/.test(fn.toString())) {
        this.unknown(callee.name, 'arguments object', fnAt, depth);
      }
      return { returns: false, summary };
    }
    let param: t.Node = params[argIndex];
    if (t.isTSParameterProperty(param)) {
      this.unknown(callee.name, 'parameter property', fnAt, depth);
      return { returns: false, summary };
    }
    if (t.isAssignmentPattern(param)) param = param.left;

    let edges: { name: string; pairs: { defLine: number; useLine: number }[] }[];
    try {
      const fetched = await this.env.edges.reachingDefs(indexFile, fnLine);
      if (fetched.truncated) {
        this.unknown(callee.name, 'pdg query truncated', fnAt, depth);
        return { returns: false, summary };
      }
      const own = `BasicBlock:${indexFile}:${fnLine}:${fnColumn}:`;
      edges = fetched.edges
        .filter((edge) => edge.src.startsWith(own))
        .map((edge) => {
          const decoded = decodeReachingDefReason(edge.reason);
          return { name: decoded.name, pairs: [...decoded.pairs] };
        });
    } catch (error) {
      this.unknown(callee.name, `pdg query failed: ${errorText(error)}`, fnAt, depth);
      return { returns: false, summary };
    }
    if (edges.some((edge) => edge.pairs.length === 0)) {
      this.unknown(callee.name, 'pdg edge without def/use lines', fnAt, depth);
      return { returns: false, summary };
    }

    const ctx: ClassifyContext = {
      file,
      fn,
      resolve: (site) =>
        site.name === null
          ? {
              origin: 'unresolved',
              name: 'call',
              container: null,
              file: null,
              declarationEnd: null,
              isClass: false,
              reason: 'callee is not an identifier',
            }
          : this.env.checker.resolveAt(file, site.name.start ?? 0, site.name.name),
      inScope: this.inScope,
      tables: module.tables,
    };
    const signature = signatureSpan(fn);
    const items: Tracked[] = Object.keys(t.getBindingIdentifiers(param)).map((name) => ({
      name,
      binding: fn.scope.getBinding(name),
      kind: 'value',
      lines: signature,
    }));
    const done = new Set<string>();
    let returns = false;
    while (items.length > 0) {
      const item = items.shift() as Tracked;
      const itemKey = `${item.name}|${item.kind}|${item.lines?.start ?? '*'}-${item.lines?.end ?? '*'}`;
      if (done.has(itemKey)) continue;
      done.add(itemKey);
      if (item.binding === undefined || ambiguousName(fn, item.name)) {
        const reason = item.binding === undefined ? 'binding not found' : 'ambiguous binding';
        this.unknown(item.name, reason, fnAt, depth);
        continue;
      }
      const usesOf = (lines: Tracked['lines']): Set<number> =>
        new Set(
          edges
            .filter((edge) => edge.name === item.name)
            .flatMap((edge) => edge.pairs)
            .filter(
              (pair) =>
                lines === null || (pair.defLine >= lines.start && pair.defLine <= lines.end),
            )
            .map((pair) => pair.useLine),
        );
      // Every def the PDG reports for the name must be the binding's declaration or one of its
      // assignments; otherwise the line mapping is off and references could be skipped silently.
      const known = defSpans(item.binding, fn);
      const stray = edges
        .filter((edge) => edge.name === item.name)
        .flatMap((edge) => edge.pairs)
        .find((pair) => !known.some((span) => within(pair.defLine, span)));
      if (stray !== undefined) {
        const reason = `pdg def on line ${stray.defLine} is not an assignment of the binding`;
        this.unknown(item.name, reason, fnAt, depth);
        continue;
      }
      const anyDef = usesOf(null);
      const ownDef = usesOf(item.lines);
      // `v += 1`, `v++`: an assignment that reads the value is no reference, but its new value
      // derives from it, so the binding is walked again from there.
      for (const violation of item.binding.constantViolations) {
        const node = violation.node;
        const compound =
          (t.isAssignmentExpression(node) && node.operator !== '=') || t.isUpdateExpression(node);
        if (!compound) continue;
        const span = spanOf(violation);
        const vAt: SinkLocation = { file, line: span.start, column: node.loc?.start.column ?? 0 };
        if (inNestedFunction(violation, fn)) {
          this.unknown(item.name, 'assigned by a closure', vAt, depth);
          continue;
        }
        const reached = item.lines === null || [...ownDef].some((line) => within(line, span));
        if (!reached) continue;
        this.sinks.push({
          class: 'repo-code',
          what: `arithmetic ${node.operator}`,
          reason: '',
          location: vAt,
          depth,
        });
        items.push({ name: item.name, binding: item.binding, kind: item.kind, lines: span });
      }
      for (const reference of item.binding.referencePaths) {
        const refAt: SinkLocation = {
          file,
          line: reference.node.loc?.start.line ?? 0,
          column: reference.node.loc?.start.column ?? 0,
        };
        if (inNestedFunction(reference, fn)) {
          this.unknown(item.name, 'captured by a closure', refAt, depth);
          continue;
        }
        const statementLine = statementOf(reference)?.node.loc?.start.line ?? refAt.line;
        const lines = [refAt.line, statementLine];
        if (!lines.some((line) => anyDef.has(line))) {
          this.unknown(item.name, 'no REACHING_DEF use', refAt, depth);
          continue;
        }
        if (!lines.some((line) => ownDef.has(line))) continue;
        const climbed = walkUp(reference, ctx, item.kind);
        returns = (await this.absorb(climbed, ctx, items, depth, stack)) || returns;
      }
    }
    return { returns, summary };
  }

  /** Records a climb's sinks, queues its derived bindings, recurses into its repo calls. */
  private async absorb(
    climbed: WalkUpResult,
    ctx: ClassifyContext,
    items: Tracked[],
    depth: number,
    stack: readonly string[],
  ): Promise<boolean> {
    for (const sink of climbed.sinks) this.sinks.push({ ...sink, depth });
    for (const derived of climbed.derived) {
      items.push({
        name: derived.name,
        binding: derived.binding,
        kind: derived.kind,
        lines: derived.kind === 'container' ? null : derived.lines,
      });
    }
    let returns = climbed.returns;
    for (const call of climbed.calls) {
      const at: SinkLocation = {
        file: ctx.file,
        line: call.call.node.loc?.start.line ?? 0,
        column: call.call.node.loc?.start.column ?? 0,
      };
      if (depth + 1 > this.env.depthCap) {
        this.unknown(call.callee.name, 'depth-cap', at, depth);
        continue;
      }
      const sub = await this.walkFunction(call.callee, call.argIndex, depth + 1, stack, at);
      if (sub.returns || (sub.summary ?? []).includes(call.argIndex)) {
        const continued = walkUp(call.call, ctx, 'value');
        returns = (await this.absorb(continued, ctx, items, depth, stack)) || returns;
      }
    }
    return returns;
  }
}

// ── The run ────────────────────────────────────────────────────────────────

const sinkKey = (sink: DepthSink): string =>
  [
    sink.class,
    sink.what,
    sink.reason,
    sink.location.file,
    sink.location.line,
    sink.location.column,
  ].join('|');

function reasonOf(sink: Sink): string {
  const reason = sink.reason === '' ? '' : ` (${sink.reason})`;
  return `${sink.class}: ${sink.what}${reason} at ${sink.location.file}:${sink.location.line}`;
}

function describeEntry(
  callee: CalleeInfo,
  inScope: (file: string) => boolean,
  testFile: string,
): string | null {
  if (callee.origin === 'library') return 'not production code (library)';
  if (callee.origin === 'declaration') return 'declaration file only';
  if (callee.origin === 'unresolved') return `unresolved (${callee.reason})`;
  // Values passed through a helper of the test file are not followed into it.
  if (callee.file === testFile) return 'a helper of the test file, not production code';
  if (callee.file === null || !inScope(callee.file)) {
    return `repo code outside the mutated files: ${callee.file ?? '?'}`;
  }
  return null;
}

async function checkPair(
  pair: ValueFlowPair,
  env: WalkEnv | null,
  degraded: readonly DegradedFlag[],
): Promise<PairValueFlow> {
  const base: PairValueFlow = {
    a: pair.a,
    b: pair.b,
    status: 'not-required',
    reasons: [],
    entries: [],
    sinks: [],
    opaqueSinks: [],
    degraded: [...degraded],
  };
  const bound = bindPair(pair.sides[0], pair.sides[1]);
  if (bound.status === 'not-required') return base;
  if (degraded.includes('no-pdg-layer'))
    return { ...base, status: 'veto', reasons: [...degraded].sort(byText) };
  if (env === null) return { ...base, status: 'unknown', reasons: [...degraded].sort(byText) };
  if (bound.status === 'unknown') return { ...base, status: 'unknown', reasons: bound.reasons };

  const scope = new Set(pair.mutate);
  const inScope = (file: string): boolean => scope.has(file);
  const walker = new PairWalker(env, inScope);
  const reasons = new Set<string>();
  const entries: EntryRecord[] = [];
  for (const position of bound.positions) {
    if (position.role !== 'input') continue;
    const [first, second] = position.entries;
    for (const [index, entry] of first.entries()) {
      const label = `entry ${entry.callee}#${entry.argIndex}`;
      const resolved = env.checker.resolveEntry(
        pair.sides[0].file,
        entry.calleeOffset,
        entry.calleeName,
        entry.argIndex,
        entry.isNew,
      );
      const twin = second[index];
      const other =
        twin === undefined
          ? null
          : env.checker.resolveAt(pair.sides[1].file, twin.calleeOffset, twin.calleeName);
      const { callee, param } = resolved;
      const problem = describeEntry(callee, inScope, pair.sides[0].file);
      entries.push({
        position: entry.position,
        kind: entry.kind,
        callee: entry.callee,
        argIndex: entry.argIndex,
        path: entry.path,
        declaration: problem === null ? `${callee.file}#${callee.name}` : null,
        param,
      });
      const at: SinkLocation = entry.location;
      if (problem !== null) {
        reasons.add(`${label}: ${problem}`);
        continue;
      }
      if (
        other === null ||
        other.file !== callee.file ||
        other.declarationEnd !== callee.declarationEnd
      ) {
        reasons.add(`${label}: the two tests resolve to different declarations`);
        continue;
      }
      if (param === null) {
        reasons.add(`${label}: parameter unresolved (${resolved.paramReason})`);
        continue;
      }
      if (param.anyOrUnknown) {
        reasons.add(`${label}: parameter ${param.name} is typed ${param.type}`);
        continue;
      }
      await walker.walkFunction(callee, entry.argIndex, 1, [], at);
    }
  }
  const seen = new Set<string>();
  const sinks = walker.sinks.filter((sink) => {
    const key = sinkKey(sink);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (const sink of sinks) {
    if (sink.class === 'opaque' || sink.class === 'unknown') reasons.add(reasonOf(sink));
  }
  const opaque = sinks.filter((sink) => sink.class === 'opaque');
  const status = opaque.length > 0 ? 'veto' : reasons.size > 0 ? 'unknown' : 'clean';
  return {
    ...base,
    status,
    reasons: [...reasons].sort(byText),
    entries,
    sinks,
    opaqueSinks: opaque.map((sink) => ({ ...sink.location, callee: sink.what })),
  };
}

/** The static value-flow check of every pair (U10). */
export async function staticValueFlow(
  pairs: readonly ValueFlowPair[],
  options: StaticValueFlowOptions,
): Promise<StaticValueFlowRun> {
  const degraded: DegradedFlag[] = [];
  let layer: PdgLayerState;
  try {
    layer = await options.edges.layerState();
  } catch {
    layer = 'unknown';
  }
  if (layer !== 'ready') degraded.push('no-pdg-layer');
  const opened = options.checker;
  if (opened.status === 'checker-version') degraded.push('checker-version');
  if (opened.status === 'error') degraded.push('checker-unavailable');
  const env: WalkEnv | null =
    opened.status === 'ready'
      ? {
          read: options.read,
          indexPrefix: options.indexPrefix,
          edges: options.edges,
          checker: opened.checker,
          depthCap: options.depthCap ?? DEPTH_CAP,
          modules: new Map(),
        }
      : null;
  const results: PairValueFlow[] = [];
  for (const pair of pairs) results.push(await checkPair(pair, env, degraded));
  return {
    degraded,
    checker: {
      version:
        opened.status === 'ready'
          ? opened.checker.version
          : opened.status === 'checker-version'
            ? opened.version
            : null,
      tsconfig: opened.status === 'ready' ? opened.checker.tsconfig : null,
      error: opened.status === 'error' ? opened.error : null,
    },
    pdgLayer: layer,
    pairs: results,
  };
}

// ── Real edge source ───────────────────────────────────────────────────────

/** A {@link PdgEdgeSource} over an analyzed checkout, and its teardown. */
export interface ClosableEdgeSource extends PdgEdgeSource {
  close(): Promise<void>;
}

const asRows = (value: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(value)) {
    const message = (value as { error?: unknown } | null)?.error;
    throw new Error(typeof message === 'string' ? message : 'cypher returned no rows');
  }
  return value.filter(
    (row): row is Record<string, unknown> => typeof row === 'object' && row !== null,
  );
};

/**
 * The edge source of an analyzed checkout (absolute path of the indexed root, registered under the
 * current `GITNEXUS_HOME`), through `LocalBackend` (pattern of bench/impact-pdg/real-code.mjs).
 * Loaded lazily, so importing this module never loads LadybugDB.
 */
export async function openLocalBackendEdgeSource(indexedRoot: string): Promise<ClosableEdgeSource> {
  const [{ LocalBackend }, { pdgLayerStatus }, { executeParameterized }, { loadMeta }] =
    await Promise.all([
      import('../../../src/mcp/local/local-backend.js'),
      import('../../../src/mcp/local/pdg-impact.js'),
      import('../../../src/core/lbug/pool-adapter.js'),
      import('../../../src/storage/repo-meta.js'),
    ]);
  const backend = new LocalBackend();
  await backend.init();
  const handle = await backend.resolveRepo(indexedRoot);
  const meta = await loadMeta(path.dirname(handle.lbugPath));
  const cap = meta?.pdg?.maxReachingDefEdgesPerFunction ?? DEFAULT_REACHING_DEF_CAP;
  const query = async (
    statement: string,
    params: Record<string, string | number>,
  ): Promise<Record<string, unknown>[]> =>
    asRows(await backend.executeCypher(indexedRoot, statement, params));
  const summaries = new Map<string, Promise<Record<string, unknown>[]>>();
  return {
    async layerState() {
      const status = await pdgLayerStatus({ lbugPath: handle.lbugPath, executeParameterized });
      return status.state;
    },
    async reachingDefs(file, fnLine) {
      const rows = await query(
        `MATCH (a:BasicBlock)-[r:CodeRelation]->(b:BasicBlock)
         WHERE r.type = 'REACHING_DEF' AND a.id STARTS WITH $prefix
         RETURN a.id AS src, b.id AS dst, r.reason AS reason
         ORDER BY src, dst, reason LIMIT ${cap + 1}`,
        { prefix: `BasicBlock:${file}:${fnLine}:` },
      );
      return {
        edges: rows.map((row) => ({
          src: String(row.src),
          dst: String(row.dst),
          reason: String(row.reason),
        })),
        truncated: rows.length >= cap,
      };
    },
    async callSummary(file, line, name) {
      let rows = summaries.get(file);
      if (rows === undefined) {
        rows = query(
          `MATCH (c)-[r:CodeRelation]->(c)
           WHERE r.type = 'CALL_SUMMARY' AND c.filePath = $file
             AND labels(c) IN ['Function', 'Method', 'Constructor']
           RETURN c.name AS name, c.startLine AS startLine, r.reason AS reason
           ORDER BY startLine, name`,
          { file },
        );
        summaries.set(file, rows);
      }
      const matches = (await rows).filter(
        (row) => Number(row.startLine) === line - 1 && (name === '' || row.name === name),
      );
      if (matches.length !== 1) return null;
      const decoded = decodeCallSummary(matches[0].reason);
      return decoded.ok ? [...decoded.returnFlowParams] : null;
    },
    async close() {
      await backend.disconnect();
    },
  };
}
