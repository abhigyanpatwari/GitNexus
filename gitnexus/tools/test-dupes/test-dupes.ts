/**
 * Advisory duplicate-test scan. CI runs it on every PR and ci-report.yml posts
 * the result in the sticky CI comment; it never fails a build.
 *
 *   same-test           same body AND same setup as an existing case
 *   assertions-pinned   every assertion is a literal `fn(...)` → matcher already asserted elsewhere
 *   same-fixture-setup  a before* hook builds a fixture another describe already builds
 *   copied-helper       a top-level test helper identical to one in another file
 *   orphan-bench-gate   a bench script with `--check` that no workflow / npm script runs
 *
 * Only findings on lines the diff touches are reported (`--all` reports the whole corpus).
 * Silence an intentional repeat with `// dupe-ok: <reason>` on the reported line or the line above.
 *
 * A case's identity is its body plus everything the body depends on: enclosing hooks and
 * describe-level statements, wrapper-call arguments, loop heads, `each` tables, referenced
 * file-local declarations (transitively) and resolved import targets. Extra context can only
 * split a group, never merge one, so the scan errs towards missing a dupe rather than
 * inventing one. Python tests are not scanned.
 *
 * The extraction is also a library for tools/scenario-map (Layer 2): `extractCases` /
 * `extract(...).records` return one `CaseRecord` per test call, suppressed and empty ones
 * included, and `buildFrame`, `resolveName`, `closure`, `staticValue`, `dupeOkReason`, the
 * call-shape helpers (`shapeOf`, `roleOf`, `eachTableOf`) and the `ENV_OR_MOCK` pattern are
 * exported with it.
 *
 * Usage (from gitnexus/; `npm run test:dupes` runs the same):
 *   node --import tsx tools/test-dupes/test-dupes.ts [--base <ref>] [--all] [--json <file>]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, type ParserPlugin } from '@babel/parser';
import { generate } from '@babel/generator';
import * as t from '@babel/types';

export type Kind =
  | 'same-test'
  | 'assertions-pinned'
  | 'same-fixture-setup'
  | 'copied-helper'
  | 'orphan-bench-gate';
export interface Location {
  file: string;
  line: number;
}
export interface Finding extends Location {
  kind: Kind;
  matches: Location[];
  detail: string;
}
export interface SourceFile {
  path: string;
  source: string;
}
/** Repo-relative file → touched lines (`'all'` for new untracked files). `null` reports everything. */
export type Touched = Map<string, Set<number> | 'all'> | null;

const PLUGINS: ParserPlugin[] = ['typescript', 'jsx', 'decorators-legacy'];
const HOOKS = new Set(['beforeAll', 'beforeEach', 'afterAll', 'afterEach']);
const MAX_MATCHES = 5;
/** Framework imports carry no test semantics; files using globals must still match. */
const FRAMEWORK_MODULES = new Set([
  'vitest',
  '@playwright/test',
  'node:test',
  'node:assert',
  'node:assert/strict',
]);
/** Setup that changes what the same call returns: module mocks, spies, env writes. */
export const ENV_OR_MOCK = /\bprocess\.env\b|\b(vi|jest)\.(mock|doMock|spyOn|stubGlobal|stubEnv)\b/;
const envOrMockTag = (chain: Frame[]): string =>
  chain
    .flatMap((f) => f.setup)
    .map(code)
    .filter((c) => ENV_OR_MOCK.test(c))
    .sort()
    .join('\0');
const MIN_HELPER_CHARS = 200;
const DEPTH = 4;

export const isTestFile = (p: string): boolean =>
  /\.(test|spec)\.[mc]?[jt]sx?$/.test(p) && !/(^|\/)(node_modules|fixtures)\//.test(p);
export const isTestSupportFile = (p: string): boolean =>
  /(^|\/)(test|tests|e2e|__tests__)\//.test(p) &&
  /\.[mc]?[jt]sx?$/.test(p) &&
  !/(^|\/)(node_modules|fixtures)\//.test(p);
const isHelperDir = (p: string): boolean => /(^|\/)(helpers|utils)\//.test(p);

// ── AST helpers ────────────────────────────────────────────────────────────

const codeMemo = new WeakMap<t.Node, string>();
function code(node: t.Node): string {
  let c = codeMemo.get(node);
  if (c === undefined) {
    c = generate(node, { comments: false, compact: true }).code;
    codeMemo.set(node, c);
  }
  return c;
}
const refsMemo = new WeakMap<t.Node, Set<string>>();
/** Every identifier name in `node`. Over-collecting only adds context (conservative). */
function refsOf(node: t.Node): Set<string> {
  let r = refsMemo.get(node);
  if (!r) {
    const names = new Set<string>();
    t.traverseFast(node, (n) => {
      if (t.isIdentifier(n)) names.add(n.name);
    });
    refsMemo.set(node, (r = names));
  }
  return r;
}
const hash = (s: string): string => createHash('sha1').update(s).digest('hex');

export interface CallShape {
  root: string;
  mods: string[];
  modArgs: t.Node[];
}
/** `it`, `it.skip`, `it.each(table)`, `test.describe.serial`, `describe.skipIf(x)` … */
export function shapeOf(callee: t.Node): CallShape | null {
  const mods: string[] = [];
  const modArgs: t.Node[] = [];
  let n = callee;
  for (;;) {
    if (t.isIdentifier(n)) return { root: n.name, mods, modArgs };
    if (t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.property)) {
      mods.push(n.property.name);
      n = n.object;
    } else if (t.isCallExpression(n)) {
      modArgs.push(...n.arguments);
      n = n.callee;
    } else if (t.isTaggedTemplateExpression(n)) {
      modArgs.push(n.quasi);
      n = n.tag;
    } else return null;
  }
}
export type Role = 'suite' | 'test' | 'hook' | 'other';
export function roleOf(call: t.CallExpression, shape: CallShape | null): Role {
  if (!shape) return 'other';
  const { root, mods } = shape;
  if (root === 'describe' || root === 'suite' || (root === 'test' && mods.includes('describe')))
    return 'suite';
  if (HOOKS.has(root) || (root === 'test' && mods.some((m) => HOOKS.has(m)))) return 'hook';
  if ((root === 'it' || root === 'test') && call.arguments.length > 1 && fnArg(call)) return 'test';
  return 'other';
}
function fnArg(call: t.CallExpression): t.ArrowFunctionExpression | t.FunctionExpression | null {
  for (const a of call.arguments)
    if (t.isArrowFunctionExpression(a) || t.isFunctionExpression(a)) return a;
  return null;
}
const stmtsOf = (body: t.Node): t.Statement[] =>
  t.isBlockStatement(body) || t.isProgram(body) ? body.body : [];
const lineOf = (n: t.Node): number => n.loc?.start.line ?? 0;
const endLineOf = (n: t.Node): number => n.loc?.end.line ?? lineOf(n);

/** A test or suite title: literal text (an `each` template stays a template), else its code. */
function titleOf(call: t.CallExpression): string {
  const a = call.arguments[0];
  if (!a) return '';
  if (t.isStringLiteral(a)) return a.value;
  if (t.isTemplateLiteral(a) && a.expressions.length === 0)
    return a.quasis[0].value.cooked ?? code(a);
  return code(a);
}
const EACH = new Set(['each', 'for']);
/** The table of `it.each(table)`, `it.each\`…\``, `test.for(table)` …; null for other modifiers. */
export function eachTableOf(callee: t.Node): t.Node | null {
  let n = callee;
  for (;;) {
    if (t.isMemberExpression(n)) n = n.object;
    else if (t.isCallExpression(n) || t.isTaggedTemplateExpression(n)) {
      const inner = t.isCallExpression(n) ? n.callee : n.tag;
      if (
        t.isMemberExpression(inner) &&
        !inner.computed &&
        t.isIdentifier(inner.property) &&
        EACH.has(inner.property.name)
      )
        return t.isCallExpression(n) ? (n.arguments[0] ?? null) : n.quasi;
      n = inner;
    } else return null;
  }
}

// ── Scope frames ───────────────────────────────────────────────────────────

export type Decl = { kind: 'import'; key: string } | { kind: 'node'; node: t.Node };
export interface Frame {
  decls: Map<string, Decl>;
  /** Side-effecting statements of this body: hooks, vi.mock, env writes … */
  setup: t.Node[];
  /** Enclosing wrapper-call args, loop heads, if-tests, params, `each` tables. */
  extra: t.Node[];
}

function resolveSpecifier(file: string, spec: string): string {
  if (!spec.startsWith('.')) return spec;
  return path.posix
    .join(path.posix.dirname(file), spec)
    .replace(/\.[mc]?[jt]sx?$/, '')
    .replace(/\/index$/, '');
}

export function buildFrame(file: string, body: t.Node, extra: t.Node[]): Frame {
  const frame: Frame = { decls: new Map(), setup: [], extra };
  for (const raw of stmtsOf(body)) {
    const stmt =
      (t.isExportNamedDeclaration(raw) || t.isExportDefaultDeclaration(raw)) && raw.declaration
        ? raw.declaration
        : raw;
    if (t.isImportDeclaration(stmt)) {
      if (FRAMEWORK_MODULES.has(stmt.source.value)) continue;
      const from = resolveSpecifier(file, stmt.source.value);
      for (const s of stmt.specifiers) {
        const imported = t.isImportSpecifier(s)
          ? t.isIdentifier(s.imported)
            ? s.imported.name
            : s.imported.value
          : t.isImportDefaultSpecifier(s)
            ? 'default'
            : '*';
        frame.decls.set(s.local.name, { kind: 'import', key: `import:${from}#${imported}` });
      }
    } else if (t.isVariableDeclaration(stmt)) {
      for (const d of stmt.declarations)
        for (const name of Object.keys(t.getBindingIdentifiers(d.id)))
          frame.decls.set(name, { kind: 'node', node: d });
    } else if (
      (t.isFunctionDeclaration(stmt) ||
        t.isClassDeclaration(stmt) ||
        t.isTSEnumDeclaration(stmt)) &&
      stmt.id
    ) {
      frame.decls.set(stmt.id.name, { kind: 'node', node: stmt });
    } else if (t.isExpressionStatement(stmt)) {
      const e = t.isAwaitExpression(stmt.expression) ? stmt.expression.argument : stmt.expression;
      const role = t.isCallExpression(e) ? roleOf(e, shapeOf(e.callee)) : 'other';
      if (role !== 'suite' && role !== 'test') frame.setup.push(stmt);
    }
  }
  return frame;
}

/** The declaration `name` resolves to through `chain`, innermost frame first. */
export function resolveName(name: string, chain: Frame[]): Decl | undefined {
  for (let i = chain.length - 1; i >= 0; i--) {
    const d = chain[i].decls.get(name);
    if (d) return d;
  }
  return undefined;
}

/** Module key (path without extension / index) → that file's top-level frame. */
export type Programs = Map<string, { file: string; frame: Frame }>;
const moduleKey = (file: string): string =>
  file.replace(/\.[mc]?[jt]sx?$/, '').replace(/\/index$/, '');

/**
 * Static value of a constant: string literals, `__dirname`, `import.meta.dirname` and
 * `path.join/resolve(...)` over those, followed through imports. Lets
 * `path.resolve(__dirname, '..', 'fixtures', 'x')` in one file equal an imported
 * `FIXTURES`-style constant pointing at the same directory in another.
 */
export function staticValue(
  decl: Decl,
  file: string,
  chain: Frame[],
  programs: Programs,
  depth = 0,
): string | undefined {
  if (depth > DEPTH) return undefined;
  if (decl.kind === 'import') {
    const m = /^import:(.+)#([^#]+)$/.exec(decl.key);
    const target = m ? programs.get(m[1]) : undefined;
    const d = target?.frame.decls.get(m?.[2] ?? '');
    return target && d
      ? staticValue(d, target.file, [target.frame], programs, depth + 1)
      : undefined;
  }
  if (!t.isVariableDeclarator(decl.node) || !t.isIdentifier(decl.node.id) || !decl.node.init)
    return undefined;
  const evaluate = (n: t.Node): string | undefined => {
    if (t.isStringLiteral(n)) return n.value;
    if (t.isTemplateLiteral(n) && n.expressions.length === 0)
      return n.quasis[0].value.cooked ?? undefined;
    if (t.isIdentifier(n)) {
      if (n.name === '__dirname') return path.posix.dirname(file);
      const d = resolveName(n.name, chain);
      return d ? staticValue(d, file, chain, programs, depth + 1) : undefined;
    }
    if (
      t.isMemberExpression(n) &&
      t.isMetaProperty(n.object) &&
      t.isIdentifier(n.property, { name: 'dirname' })
    )
      return path.posix.dirname(file);
    if (
      t.isCallExpression(n) &&
      t.isMemberExpression(n.callee) &&
      t.isIdentifier(n.callee.object, { name: 'path' }) &&
      t.isIdentifier(n.callee.property) &&
      /^(join|resolve)$/.test(n.callee.property.name)
    ) {
      const parts = n.arguments.map(evaluate);
      if (parts.some((p) => p === undefined || p.startsWith('/'))) return undefined;
      const joined = path.posix.normalize(path.posix.join(...(parts as string[])));
      return joined.startsWith('..') ? undefined : joined;
    }
    return undefined;
  };
  return evaluate(decl.node.init);
}

/** Every declaration `nodes` reach through `chain`, transitively: code, import key or static value. */
export function closure(
  nodes: t.Node[],
  chain: Frame[],
  file: string,
  programs: Programs,
): string[] {
  const out = new Set<string>();
  const seen = new Set<t.Node>();
  const visit = (n: t.Node, depth: number): void => {
    for (const name of refsOf(n)) {
      const d = resolveName(name, chain);
      if (!d) continue;
      const value = staticValue(d, file, chain, programs);
      if (value !== undefined) out.add(`value:${value}`);
      else if (d.kind === 'import') out.add(d.key);
      else if (!seen.has(d.node)) {
        seen.add(d.node);
        out.add(code(d.node));
        if (depth < DEPTH) visit(d.node, depth + 1);
      }
    }
  };
  for (const n of nodes) visit(n, 0);
  return [...out].sort();
}

// ── Literal assertions: expect(fn('x')).toBe(1) ─────────────────────────────

function isLiteral(n: t.Node): boolean {
  if (t.isTSAsExpression(n) || t.isTSSatisfiesExpression(n)) return isLiteral(n.expression);
  if (
    t.isStringLiteral(n) ||
    t.isNumericLiteral(n) ||
    t.isBooleanLiteral(n) ||
    t.isNullLiteral(n) ||
    t.isBigIntLiteral(n) ||
    t.isRegExpLiteral(n)
  )
    return true;
  if (t.isIdentifier(n)) return n.name === 'undefined';
  if (t.isTemplateLiteral(n)) return n.expressions.length === 0;
  if (t.isUnaryExpression(n)) return n.operator === '-' && t.isNumericLiteral(n.argument);
  if (t.isArrayExpression(n)) return n.elements.every((e) => e !== null && isLiteral(e));
  if (t.isObjectExpression(n))
    return n.properties.every((p) => t.isObjectProperty(p) && !p.computed && isLiteral(p.value));
  return false;
}

/** Stable key for an imported / file-level function callee, else null. */
function calleeKey(callee: t.Node, chain: Frame[]): string | null {
  const members: string[] = [];
  let n = callee;
  while (t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.property)) {
    members.unshift(n.property.name);
    n = n.object;
  }
  if (!t.isIdentifier(n)) return null;
  const d = resolveName(n.name, chain);
  if (!d) return null;
  if (d.kind === 'import') return [d.key, ...members].join('.');
  const fn =
    t.isFunctionDeclaration(d.node) ||
    (t.isVariableDeclarator(d.node) &&
      (t.isArrowFunctionExpression(d.node.init) || t.isFunctionExpression(d.node.init)));
  return fn ? [code(d.node), ...members].join('.') : null;
}

/** `expect(subject).not.toBe(x)` → its parts, else null. */
function matcherCall(
  n: t.Node,
): { subject: t.Node; matcher: string[]; args: t.CallExpression['arguments'] } | null {
  const e = t.isExpressionStatement(n) ? n.expression : n;
  const call = t.isAwaitExpression(e) ? e.argument : e;
  if (!t.isCallExpression(call)) return null;
  const matcher: string[] = [];
  let c: t.Node = call.callee;
  while (t.isMemberExpression(c) && !c.computed && t.isIdentifier(c.property)) {
    matcher.unshift(c.property.name);
    c = c.object;
  }
  if (!matcher.length || !t.isCallExpression(c) || c.arguments.length !== 1) return null;
  if (!t.isIdentifier(c.callee, { name: 'expect' })) return null;
  return { subject: c.arguments[0], matcher, args: call.arguments };
}

/**
 * Literal assertion signatures — only for bodies made of nothing but `expect` statements,
 * since any other statement may change what the call returns (env writes, setup calls).
 * Subjects must call an imported or file-level function with ≥1 literal argument; zero-arg
 * getters and params/locals (`page.locator('x')`, `calls()`) read per-test state.
 */
function assertionSignatures(body: t.Node, chain: Frame[]): { sigs: string[]; all: boolean } {
  const stmts = t.isBlockStatement(body) ? body.body : [body];
  const calls = stmts.map(matcherCall);
  if (!stmts.length || calls.some((c) => c === null)) return { sigs: [], all: false };
  // A mocked module returns something else for the same call — keep mocked files apart.
  const mocks = envOrMockTag(chain);
  const mockTag = mocks ? `${hash(mocks)}|` : '';
  const sigs: string[] = [];
  for (const c of calls) {
    if (!c) continue;
    const { subject, matcher, args } = c;
    if (!t.isCallExpression(subject) || !subject.arguments.length) continue;
    if (!subject.arguments.every(isLiteral) || !args.every(isLiteral)) continue;
    const key = calleeKey(subject.callee, chain);
    if (!key) continue;
    sigs.push(
      `${mockTag}${key}(${subject.arguments.map(code).join(',')})|${matcher.join('.')}(${args.map(code).join(',')})`,
    );
  }
  return { sigs, all: sigs.length === stmts.length };
}

// ── Corpus extraction ──────────────────────────────────────────────────────

export interface Item extends Location {
  endLine: number;
  key: string;
}
export interface Case extends Item {
  sigs: string[];
  allLiteral: boolean;
}
export interface Helper extends Item {
  exported: boolean;
}
/**
 * One test call as written, with the parts Layer 0 folds into `key` (body, params, call-modifier
 * arguments such as the `each` table, context) kept apart. A call with an `each` table or inside
 * a loop is one record for all of its runtime instances.
 */
export interface CaseRecord extends Item {
  /** Enclosing `describe` / `suite` titles, outermost first. */
  describePath: string[];
  /** The title argument; an `each` title stays a template (`doubles %s`). */
  title: string;
  /**
   * Hash of the context alone: enclosing hooks and describe-level statements, wrapper-call
   * arguments, loop heads, if-tests, and every declaration the case reaches. Title, line, body,
   * own params and own call-modifier arguments are not part of it.
   */
  contextHash: string;
  /** The body as compact code without comments (the text folded into `key`). */
  body: string;
  call: t.CallExpression;
  fn: t.ArrowFunctionExpression | t.FunctionExpression;
  /** The `it.each` / `test.for` table (array or tagged template), else null. */
  each: t.Node | null;
  /** The nearest enclosing loop statement, whose head varies per iteration, else null. */
  loop: t.Loop | null;
  /** Scope frames from the file's top level down to the body enclosing the call. */
  chain: Frame[];
  /** The `// dupe-ok:` reason (`''` when blank); null when the case is not suppressed. */
  suppressed: string | null;
}
export interface Corpus {
  /** Layer 0's cases: the unsuppressed records with a non-empty body, under the same `key`. */
  cases: Case[];
  /** Every test call of every test file, in walk order. */
  records: CaseRecord[];
  hooks: Item[];
  helpers: Helper[];
  skipped: string[];
  /** Top-level frame per module key, for `closure` / `staticValue` over these files. */
  programs: Programs;
  /** The AST of each parsed file by path, the one the records' nodes belong to. */
  asts: Map<string, t.File>;
}

const DUPE_OK = /dupe-ok:(.*)/;
/** The `dupe-ok:` reason on 1-based `line` or the line above (the line itself wins), else null. */
export function dupeOkReason(lines: string[], line: number): string | null {
  const m = DUPE_OK.exec(lines[line - 1] ?? '') ?? DUPE_OK.exec(lines[line - 2] ?? '');
  return m ? m[1].trim() : null;
}
export function suppressed(lines: string[], line: number): boolean {
  return dupeOkReason(lines, line) !== null;
}

export interface ExtractOptions {
  /**
   * Which files' test calls become records; default {@link isTestFile}. tools/scenario-map passes
   * its eligible set, which in `controls` mode holds `*.case.ts` files under `test/fixtures/`.
   */
  isTest?: (path: string) => boolean;
}

export function extract(files: SourceFile[], options: ExtractOptions = {}): Corpus {
  const isTest = options.isTest ?? isTestFile;
  const skipped: string[] = [];
  const parsed: { file: string; ast: t.File; lines: string[] }[] = [];
  for (const { path: file, source } of files) {
    try {
      const ast = parse(source, { sourceType: 'module', plugins: PLUGINS, errorRecovery: true });
      parsed.push({ file, ast, lines: source.split('\n') });
    } catch {
      skipped.push(file);
    }
  }
  const programs: Programs = new Map(
    parsed.map(({ file, ast }) => [
      moduleKey(file),
      { file, frame: buildFrame(file, ast.program, []) },
    ]),
  );
  const corpus: Corpus = {
    cases: [],
    records: [],
    hooks: [],
    helpers: [],
    skipped,
    programs,
    asts: new Map(parsed.map(({ file, ast }) => [file, ast])),
  };
  for (const { file, ast, lines } of parsed) {
    const keep = (n: t.Node): boolean => !suppressed(lines, lineOf(n));

    for (const raw of ast.program.body) {
      const exported = t.isExportNamedDeclaration(raw) || t.isExportDefaultDeclaration(raw);
      const stmt = exported && raw.declaration ? raw.declaration : raw;
      const fn = t.isFunctionDeclaration(stmt)
        ? stmt
        : t.isVariableDeclaration(stmt) &&
            stmt.declarations.length === 1 &&
            (t.isArrowFunctionExpression(stmt.declarations[0].init) ||
              t.isFunctionExpression(stmt.declarations[0].init))
          ? stmt.declarations[0].init
          : null;
      if (!fn || !keep(raw)) continue;
      const key = `${fn.params.map(code).join(',')}=>${code(fn.body)}`;
      if (key.length < MIN_HELPER_CHARS) continue;
      corpus.helpers.push({ file, line: lineOf(raw), endLine: endLineOf(raw), key, exported });
    }
    if (!isTest(file)) continue;

    // Enclosing describe titles and loops of the node being walked (walk is depth-first).
    const suites: string[] = [];
    const loops: t.Loop[] = [];
    const enter = (body: t.Node, extra: t.Node[], chain: Frame[]): void => {
      const frame = buildFrame(file, body, extra);
      const next = [...chain, frame];
      for (const s of frame.setup) recordHook(s, next);
      for (const s of stmtsOf(body)) walk(s, next);
      if (!t.isBlockStatement(body) && !t.isProgram(body)) walk(body, next);
    };
    const walk = (node: t.Node | null | undefined, chain: Frame[]): void => {
      if (!node || typeof node.type !== 'string') return;
      if (t.isCallExpression(node)) {
        const shape = shapeOf(node.callee);
        const role = roleOf(node, shape);
        const fn = fnArg(node);
        if (role === 'test' && fn && shape) {
          recordCase(node, fn, shape, chain);
          return;
        }
        if (role === 'test' || role === 'hook') return;
        if (role === 'suite' && fn && shape) {
          suites.push(titleOf(node));
          enter(fn.body, shape.modArgs, chain);
          suites.pop();
          return;
        }
        walk(node.callee, chain);
        for (const a of node.arguments) {
          if (t.isArrowFunctionExpression(a) || t.isFunctionExpression(a))
            enter(
              a.body,
              [node.callee, ...node.arguments.filter((x) => x !== a), ...a.params],
              chain,
            );
          else walk(a, chain);
        }
        return;
      }
      if (t.isFunction(node)) return enter(node.body, node.params, chain);
      if (t.isLoop(node)) {
        const head = t.isForStatement(node)
          ? [node.init, node.test, node.update]
          : t.isForInStatement(node) || t.isForOfStatement(node)
            ? [node.left, node.right]
            : [node.test];
        loops.push(node);
        enter(
          node.body,
          head.filter((h): h is NonNullable<typeof h> => h != null),
          chain,
        );
        loops.pop();
        return;
      }
      if (t.isIfStatement(node)) {
        enter(node.consequent, [node.test], chain);
        if (node.alternate) enter(node.alternate, [t.unaryExpression('!', node.test)], chain);
        return;
      }
      if (t.isBlockStatement(node)) return enter(node, [], chain);
      for (const k of t.VISITOR_KEYS[node.type] ?? []) {
        const v = (node as unknown as Record<string, unknown>)[k];
        if (Array.isArray(v)) for (const c of v) walk(c as t.Node, chain);
        else walk(v as t.Node, chain);
      }
    };

    const context = (chain: Frame[], own: t.Node[]): string[] => {
      const nodes = [...own, ...chain.flatMap((f) => [...f.setup, ...f.extra])];
      return [
        ...nodes.slice(own.length).map(code),
        ...closure(nodes, chain, file, programs),
      ].sort();
    };

    const recordCase = (
      call: t.CallExpression,
      fn: t.ArrowFunctionExpression | t.FunctionExpression,
      shape: CallShape,
      chain: Frame[],
    ): void => {
      const body = code(fn.body);
      const own = [fn.body, ...fn.params, ...shape.modArgs];
      const parts = context(chain, own);
      const key = hash(
        [body, ...fn.params.map(code), ...shape.modArgs.map(code), ...parts].join('\0'),
      );
      const line = lineOf(call);
      const endLine = endLineOf(call);
      const reason = dupeOkReason(lines, line);
      corpus.records.push({
        file,
        line,
        endLine,
        key,
        describePath: [...suites],
        title: titleOf(call),
        contextHash: hash(parts.join('\0')),
        body,
        call,
        fn,
        each: eachTableOf(call.callee),
        loop: loops.at(-1) ?? null,
        chain,
        suppressed: reason,
      });
      if (reason !== null || body === '{}') return;
      const { sigs, all } = assertionSignatures(fn.body, chain);
      corpus.cases.push({ file, line, endLine, key, sigs, allLiteral: all });
    };

    /** `x = await build(fixture)` inside a before* hook. */
    const recordHook = (stmt: t.Node, chain: Frame[]): void => {
      if (!t.isExpressionStatement(stmt) || !t.isCallExpression(stmt.expression)) return;
      const shape = shapeOf(stmt.expression.callee);
      const fn = fnArg(stmt.expression);
      // The hook name is part of the key: a beforeAll fixture is built once per suite, a
      // beforeEach one per test, so the two are not the same setup.
      const hook = shape ? ([shape.root, ...shape.mods].find((m) => HOOKS.has(m)) ?? '') : '';
      if (!fn || !hook.startsWith('before')) return;
      t.traverseFast(fn.body, (n) => {
        if (!t.isAssignmentExpression(n) || !t.isIdentifier(n.left)) return;
        const rhs = t.isAwaitExpression(n.right) ? n.right.argument : n.right;
        if (!t.isCallExpression(rhs) || !keep(n)) return;
        if (t.isMemberExpression(rhs.callee) && t.isIdentifier(rhs.callee.object, { name: 'path' }))
          return; // building a path is not building a fixture
        const refs = closure([rhs], chain, file, programs);
        // ponytail: a `fixtures/` path in the call's literals or resolved constants marks a
        // fixture build; temp dirs named `fixture` don't count. A fixture registry is the upgrade.
        if (
          !/fixtures?\//.test([code(rhs), ...refs.filter((r) => r.startsWith('value:'))].join('\0'))
        )
          return;
        const sig = [hook, code(rhs), ...refs, envOrMockTag(chain)].join('\0');
        corpus.hooks.push({ file, line: lineOf(n), endLine: endLineOf(n), key: hash(sig) });
      });
    };

    enter(ast.program, [], []);
  }
  return corpus;
}

/**
 * Every test call in `file` (which must pass `options.isTest`, default `isTestFile`), in walk
 * order. Imports resolve against `file` alone; `extract(files).records` follows constants into the
 * other files as Layer 0 does.
 */
export function extractCases(file: SourceFile, options: ExtractOptions = {}): CaseRecord[] {
  return extract([file], options).records;
}

// ── Grouping and reporting ─────────────────────────────────────────────────

const touches = (touched: Touched, it: Location & { endLine: number }): boolean => {
  if (touched === null) return true;
  const lines = touched.get(it.file);
  if (!lines) return false;
  if (lines === 'all') return true;
  for (let l = it.line; l <= it.endLine; l++) if (lines.has(l)) return true;
  return false;
};
const loc = (it: Location): Location => ({ file: it.file, line: it.line });

function groupFindings<T extends Item>(
  items: T[],
  touched: Touched,
  kind: Kind,
  detail: (first: T, others: T[]) => string | null,
): Finding[] {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const g = groups.get(it.key);
    if (g) g.push(it);
    else groups.set(it.key, [it]);
  }
  const out: Finding[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const first = g.find((it) => touches(touched, it));
    if (!first) continue;
    const others = g.filter((it) => it !== first);
    const d = detail(first, others);
    if (d === null) continue;
    out.push({ kind, ...loc(first), matches: others.slice(0, MAX_MATCHES).map(loc), detail: d });
  }
  return out;
}

export function scan(
  files: SourceFile[],
  touched: Touched,
): { findings: Finding[]; skipped: string[] } {
  const corpus = extract(files);
  const findings: Finding[] = [];

  const sameTest = groupFindings(
    corpus.cases,
    touched,
    'same-test',
    () => 'same body and setup as an existing test',
  );
  findings.push(...sameTest);
  // Members of a same-test group are reported there whenever touched.
  const groupSize = new Map<string, number>();
  for (const c of corpus.cases) groupSize.set(c.key, (groupSize.get(c.key) ?? 0) + 1);

  const bySig = new Map<string, Set<Case>>();
  for (const c of corpus.cases)
    for (const s of c.sigs) {
      const set = bySig.get(s);
      if (set) set.add(c);
      else bySig.set(s, new Set([c]));
    }
  for (const c of corpus.cases) {
    if (!c.allLiteral || (groupSize.get(c.key) ?? 0) > 1 || !touches(touched, c)) continue;
    const others = new Set<Case>();
    const pinned = c.sigs.every((s) => {
      const holders = [...(bySig.get(s) ?? [])].filter((o) => o !== c);
      holders.forEach((o) => others.add(o));
      return holders.length > 0;
    });
    if (!pinned) continue;
    findings.push({
      kind: 'assertions-pinned',
      ...loc(c),
      matches: [...others].slice(0, MAX_MATCHES).map(loc),
      detail: `all ${c.sigs.length} assertion(s) already made by other tests`,
    });
  }

  findings.push(
    ...groupFindings(
      corpus.hooks,
      touched,
      'same-fixture-setup',
      () => 'fixture already built by another describe — share one result',
    ),
    ...groupFindings(corpus.helpers, touched, 'copied-helper', (first, others) => {
      const elsewhere = others.filter((o) => o.file !== first.file);
      if (!elsewhere.length) return null;
      if (first.exported && isHelperDir(first.file))
        return 'identical copies in other files should import this helper';
      const home = elsewhere.find((o) => o.exported && isHelperDir(o.file));
      return home
        ? `already exported from ${home.file} — import it`
        : 'move to a shared test helper';
    }),
  );
  return { findings, skipped: corpus.skipped };
}

/** Bench scripts with a `--check` gate that no workflow, npm script or runner references. */
export function orphanBenchGates(files: SourceFile[], touched: Touched): Finding[] {
  const isRunner = (p: string): boolean =>
    /^\.github\/workflows\/.+\.ya?ml$/.test(p) ||
    /(^|\/)package\.json$/.test(p) ||
    /^gitnexus\/scripts\/[^/]+\.[mc]?[jt]s$/.test(p);
  const runners = files.filter((f) => isRunner(f.path)).map((f) => f.source);
  const out: Finding[] = [];
  for (const f of files) {
    if (!/^gitnexus\/(bench|scripts\/bench)\/.+\.[mc]?[jt]s$/.test(f.path)) continue;
    if (f.path.startsWith('gitnexus/bench/lib/')) continue; // imported by benches, never run
    const lines = f.source.split('\n');
    const idx = lines.findIndex((l) => l.includes('--check'));
    if (idx < 0 || suppressed(lines, idx + 1)) continue;
    // Like every other kind: only a changed `--check` line is reported, not any edit to the file.
    if (!touches(touched, { file: f.path, line: idx + 1, endLine: idx + 1 })) continue;
    const ref = f.path.replace(/^gitnexus\//, '');
    if (runners.some((s) => s.includes(ref))) continue;
    const dir = path.posix.dirname(f.path);
    const base = path.posix.basename(f.path);
    const imported = files.some(
      (o) => o !== f && path.posix.dirname(o.path) === dir && o.source.includes(`./${base}`),
    );
    if (imported) continue; // a library of a sibling bench script
    out.push({
      kind: 'orphan-bench-gate',
      file: f.path,
      line: idx + 1,
      matches: [],
      detail: `no workflow, package.json script or gitnexus/scripts runner invokes ${ref}`,
    });
  }
  return out;
}

/** `git diff -U0` → touched new-side lines per file. */
export function parseUnifiedDiff(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let file: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m || !file) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    const set = out.get(file) ?? new Set<number>();
    for (let i = 0; i < count; i++) set.add(start + i);
    out.set(file, set);
  }
  return out;
}

// ── CLI ────────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const git = (...a: string[]): string =>
    execFileSync('git', ['-c', 'core.quotePath=false', ...a], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  const jsonOut = opt('--json'); // relative to the caller's cwd, resolved before chdir
  const json = jsonOut ? path.resolve(jsonOut) : undefined;
  const root = git('rev-parse', '--show-toplevel').trim();
  process.chdir(root);
  const all = args.includes('--all');
  let base = opt('--base');
  let touched: Touched = null;
  if (!all) {
    if (!base) {
      try {
        base = git('merge-base', 'HEAD', 'origin/main').trim();
      } catch {
        throw new Error('Cannot find merge-base with origin/main; pass --base <ref> or --all');
      }
    }
    touched = parseUnifiedDiff(git('diff', '-U0', '--no-color', '--no-ext-diff', base, '--'));
    for (const p of git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean))
      touched.set(p, 'all');
  }
  const paths = git('ls-files', '--cached', '--others', '--exclude-standard')
    .split('\n')
    .filter(Boolean);
  const read = (p: string): SourceFile | null => {
    try {
      return { path: p, source: readFileSync(p, 'utf8') };
    } catch {
      return null; // deleted in the working tree but still in the index
    }
  };
  const support = paths
    .filter(isTestSupportFile)
    .map(read)
    .filter((f): f is SourceFile => f !== null);
  const benchAndRunners = paths
    .filter(
      (p) =>
        /^gitnexus\/(bench|scripts)\//.test(p) ||
        /^\.github\/workflows\//.test(p) ||
        /(^|\/)package\.json$/.test(p),
    )
    .filter((p) => !p.includes('node_modules/'))
    .map(read)
    .filter((f): f is SourceFile => f !== null);

  const { findings, skipped } = scan(support, touched);
  findings.push(...orphanBenchGates(benchAndRunners, touched));
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  const report = {
    version: 1,
    base: base ?? null,
    all,
    scanned: support.length,
    skipped,
    findings,
  };
  if (json) {
    mkdirSync(path.dirname(json), { recursive: true });
    writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(
    `test-dupes: ${findings.length} finding(s) in ${support.length} files` +
      (all ? ' (whole corpus)' : ` (lines changed since ${base})`) +
      (skipped.length ? `; ${skipped.length} unparseable: ${skipped.join(', ')}` : ''),
  );
  for (const f of findings)
    console.log(
      `  ${f.kind.padEnd(18)} ${f.file}:${f.line}  ${f.detail}` +
        f.matches.map((m) => `\n${' '.repeat(22)}↳ ${m.file}:${m.line}`).join(''),
    );
}
