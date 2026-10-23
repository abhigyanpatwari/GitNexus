/**
 * Pure-JS category classifier (U5, KTD11, KTD19).
 *
 * Decides which `gitnexus/test/unit` files a mutation run can use in a prepared copy
 * (tools/mutation/prepare) without native code, workers, child processes, or file reads that the
 * prepared copy breaks. Gate 1 (U6) records the modules each accepted test loads at runtime and
 * fails on a native binding, worker or child_process load, so a miss here surfaces there.
 *
 * Walk. Each test file's import closure, parsed with @babel/parser:
 *  - `import` declarations, except `import type`, type-only specifiers, and value imports whose
 *    bindings are never used as values (the TypeScript transform erases those, because the repo
 *    does not set `verbatimModuleSyntax`); `export ... from`; `import x = require()`.
 *  - `import()`, `require()`, `createRequire(<base>)` results called directly or through a const,
 *    `vi.importActual()`, `vi.importMock()`, and `vi.mock()`/`vi.doMock()` unless the factory
 *    takes no parameter (automocking and `importOriginal` load the real module).
 *  A specifier must evaluate statically: a string literal, a template or `+` concatenation of
 *  those, an identifier whose binding (resolved lexically; a redeclared name is unknown) is a
 *  `const` initialised with such a value, or an absolute path or file URL built from
 *  `import.meta.url`, `__dirname`, `process.cwd()`, `path.join/resolve/dirname/sep`, `new URL()`,
 *  `fileURLToPath()` and `pathToFileURL().href`. Type assertions are looked through.
 *  Anything else is "unresolvable dynamic import". Relative specifiers resolve like Vite (exact
 *  file, `.js` to `.ts`/`.tsx`, appended extensions, directory `index`); `gitnexus-shared[/x]`
 *  resolves through that package's `exports` (`./dist/X.js` maps to `src/X.ts`, KTD8); node
 *  builtins and other bare packages are leaves (package code is not walked).
 *
 * Rejection reasons:
 *  - `native package: <name>`: a bare package on {@link KNOWN_NATIVE_PACKAGES}, or one that ships a
 *    `.node` file, a `binding.gyp` or `"gypfile": true`, or reaches such a package through the
 *    installed packages of its `dependencies`/`optionalDependencies`. `vitest` and `@vitest/*` are
 *    the harness and exempt.
 *  - `native binding: <path>`: an import resolves to a `.node` file.
 *  - `spawns processes: child_process|cluster`: the closure imports that builtin, or a package on
 *    {@link KNOWN_PROCESS_PACKAGES} (its own code loads `child_process` when imported).
 *  - `spawns workers: worker_threads`: the closure imports `Worker` from `worker_threads`, or the
 *    whole module (default/namespace binding, non-destructured `require`/`import()`).
 *  - `imports outside gitnexus/`, `imports from ignored dir: <dir>/`: a relative import leaves the
 *    package (gitnexus-shared/src is reachable only through its alias, and a shared module may
 *    not leave gitnexus-shared/src), or lands in a directory the Stryker sandbox omits
 *    (stryker-config.ts `DEFAULT_IGNORED_DIRS`).
 *  - `unresolved import: <specifier>`, `unsupported import specifier: <specifier>`,
 *    `unresolvable dynamic import`, `parse error`.
 *  - Reads, checked in test-side modules only (every module of the closure outside `gitnexus/src`
 *    and `gitnexus-shared/src`; production modules that import fs do not count):
 *    `reads source under src/`, `reads test fixtures`, `reads ignored dir: <dir>/`,
 *    `reads source outside gitnexus/`, `unresolvable file path`. Two rules: (a) every path
 *    expression anchored to a location (`__dirname`, `__filename`, `import.meta.url|dirname|
 *    filename`, `process.cwd()`, or a const bound to one) is evaluated through the functions above,
 *    templates and `+`, whether or not it reaches an fs call; (b) the first argument of an
 *    `fs`/`fs/promises` call that is a relative literal resolves against the package dir (the
 *    Vitest root and cwd). When a trailing part is not static, the known prefix decides, and a
 *    prefix that contains a checked directory (the package root, `test/`, anything above the
 *    package) is "unresolvable file path".
 *
 * Limits: paths built by helper functions or passed through parameters are not followed, and a
 * production function reading a path the test hands it is not seen; an unknown suffix is assumed
 * not to contain `..`; package internals are not walked for child_process or worker use (gate 1
 * sees them, and the packages it finds go on {@link KNOWN_PROCESS_PACKAGES}); `vi.mock` factories
 * do not neutralise a module other imports load (conservative); Babel parse failures reject the
 * file; hook and test counts look at the test file only.
 *
 * CLI (from gitnexus/):
 *   node --import tsx tools/mutation/classify/classify.ts [--root test/unit] [--file <path>]...
 *     [--out <file.json>] [--closure]
 * Without `--out` the JSON goes to stdout; with it, a summary does. `--closure` keeps each file's
 * closure, package and builtin lists in the JSON.
 */
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parse, type ParserOptions } from '@babel/parser';
import {
  VISITOR_KEYS,
  type CallExpression,
  type ExportNamedDeclaration,
  type File,
  type ImportDeclaration,
  type MemberExpression,
  type NewExpression,
  type Node,
} from '@babel/types';
import { DEFAULT_IGNORED_DIRS } from '../driver/stryker-config.js';

export const CLASSIFY_SCHEMA_VERSION = 1;

/**
 * Packages rejected by name, installed or not, so the verdict does not depend on what a checkout
 * installed; detection on disk adds the rest. `@huggingface/transformers` always depends on
 * `onnxruntime-node` and `sharp`.
 */
export const KNOWN_NATIVE_PACKAGES: readonly RegExp[] = Object.freeze([
  /^tree-sitter$/,
  /^tree-sitter-/,
  /^@ladybugdb\//,
  /^onnxruntime-/,
  /^@huggingface\/transformers$/,
  /^sharp$/,
  /^fsevents$/,
  /^node-gyp-build$/,
  /^bindings$/,
]);

/**
 * Pure-JS packages whose own code loads `child_process` when imported. The walk does not enter
 * package code, so gate 1's runtime load check (tools/mutation/fidelity) finds them; each entry
 * names its evidence. `commander`: lib/command.js requires `node:child_process` at the top (for
 * executable subcommands); gate 1 saw it load in test/unit/cli-command-banner.test.ts.
 */
export const KNOWN_PROCESS_PACKAGES: readonly RegExp[] = Object.freeze([/^commander$/]);

/** The test harness itself: always loaded, never a reason to reject. */
const isHarnessPackage = (name: string): boolean =>
  name === 'vitest' || name.startsWith('@vitest/');

const SHARED_PACKAGE = 'gitnexus-shared';
const PROCESS_BUILTINS = new Set(['child_process', 'cluster']);
const WORKER_BUILTIN = 'worker_threads';
const FS_MODULES = new Set(['fs', 'fs/promises']);
const PATH_MODULES = new Set(['path', 'url']);
const PATH_ONLY = new Set(['path']);
const BUILTINS = new Set(builtinModules);

/** Vite's default `resolve.extensions` order. */
const APPENDED_EXTENSIONS = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'];
const TS_FOR_JS: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};
const WALKED_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

const HOOK_NAMES = ['beforeAll', 'beforeEach', 'afterAll', 'afterEach'] as const;
const TEST_ROOTS = new Set(['it', 'test']);
const EACH_ROOTS = new Set(['it', 'test', 'describe', 'suite']);

// ── Public types ───────────────────────────────────────────────────────────

export type HookCounts = Record<(typeof HOOK_NAMES)[number], number>;

export interface Evidence {
  reason: string;
  /** Repo-relative POSIX path of the module where the reason was found. */
  module: string;
  line: number;
  detail: string;
  /** Import chain from the test file to {@link module}, both included. */
  via: string[];
}

export interface FileVerdict {
  /** Package-relative POSIX path, e.g. `test/unit/schema.test.ts`. */
  file: string;
  status: 'accepted' | 'rejected';
  /** Sorted, distinct; empty when accepted. */
  reasons: string[];
  /** The first occurrence of each reason in breadth-first closure order, sorted by reason. */
  evidence: Evidence[];
  hooks: HookCounts;
  /** `.each`/`.for` calls on `it`/`test`/`describe`/`suite` in the test file. */
  eachCalls: number;
  /** Outermost `it`/`test` call sites in the test file (an `it.each` row set counts once). */
  testCalls: number;
  /** Repo-relative local modules and data files of the import closure, test file included. */
  closure: string[];
  /** Bare packages the closure imports (leaves). */
  packages: string[];
  /** Node builtins the closure imports, without the `node:` prefix. */
  builtins: string[];
}

export interface ClassificationSummary {
  total: number;
  accepted: number;
  rejected: number;
  /** Rejected files per reason; a file counts once for each of its reasons. */
  byReason: Record<string, number>;
  /** Rejected files per reason category (the text before `: `). */
  byCategory: Record<string, number>;
}

export interface Classification {
  schemaVersion: typeof CLASSIFY_SCHEMA_VERSION;
  /** Package-relative directory that was listed, or null for an explicit file list. */
  testRoot: string | null;
  files: FileVerdict[];
  accepted: string[];
  rejected: { file: string; reasons: string[] }[];
  acceptedWithBeforeAll: string[];
  summary: ClassificationSummary;
}

export interface ClassifyOptions {
  /** Directory holding `gitnexus/` and `gitnexus-shared/`. */
  repoRoot: string;
  /** Package-relative test files; defaults to every `*.test.ts` under {@link testRoot}. */
  testFiles?: readonly string[];
  /** Package-relative directory to list; default `test/unit`. */
  testRoot?: string;
}

// ── Static values ──────────────────────────────────────────────────────────

/**
 * What an expression evaluates to: plain text, an absolute file path (or file URL) anchored to a
 * known location, or unknown. A `file` value with `exact: false` is a prefix: the expression
 * names something inside `abs` whose remaining segments are not static.
 */
type Value =
  | { kind: 'text'; text: string }
  | { kind: 'file'; abs: string; url: boolean; exact: boolean }
  | { kind: 'unknown' };

const UNKNOWN: Value = { kind: 'unknown' };
const text = (value: string): Value => ({ kind: 'text', text: value });
const file = (abs: string, url = false): Value => ({ kind: 'file', abs, url, exact: true });

/** A name's declaration; a `const` keeps the scopes around it to evaluate its initialiser. */
type Binding =
  | { kind: 'const'; init: Node | null | undefined; scopes: readonly Node[] }
  | { kind: 'import'; source: string; imported: string }
  | { kind: 'other' };

const OTHER: Binding = { kind: 'other' };

type EdgeTarget =
  | { kind: 'specifier'; specifier: string; fromDir: string }
  | { kind: 'file'; abs: string };

interface ImportEdge {
  target: EdgeTarget;
  line: number;
  /** Imported names when known; null when the importer can reach every export. */
  names: readonly string[] | null;
}

interface Finding {
  reason: string;
  line: number;
  detail: string;
}

interface ModuleFacts {
  edges: ImportEdge[];
  /** Reasons that apply wherever the module sits (unresolvable dynamic imports, parse errors). */
  findings: Finding[];
  /** Read-rule hits; computed for test-side modules only. */
  reads: Finding[];
  hooks: HookCounts;
  eachCalls: number;
  testCalls: number;
}

type Resolved =
  | { kind: 'module'; abs: string }
  | { kind: 'leaf'; abs: string }
  | { kind: 'builtin'; name: string }
  | { kind: 'package'; name: string }
  | { kind: 'reject'; reason: string; detail: string };

// ── AST helpers ────────────────────────────────────────────────────────────

/** Keys holding type syntax, which never runs. */
const TYPE_KEYS = new Set([
  'typeAnnotation',
  'typeParameters',
  'typeArguments',
  'returnType',
  'superTypeArguments',
  'superTypeParameters',
  'implements',
  'predicate',
]);

/** Declarations that are types only. */
const TYPE_ONLY_NODES = new Set([
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSDeclareFunction',
  'TSDeclareMethod',
  'TSIndexSignature',
  'TSImportType',
]);

const KEYED_NODES = new Set([
  'ObjectProperty',
  'ObjectMethod',
  'ClassProperty',
  'ClassMethod',
  'ClassAccessorProperty',
  'ClassPrivateProperty',
  'ClassPrivateMethod',
]);

const FUNCTION_NODES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
  'ClassPrivateMethod',
]);

/** Nodes that open a lexical scope (`var` goes to the nearest function or the program). */
const SCOPE_NODES = new Set([
  'Program',
  'BlockStatement',
  'CatchClause',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'SwitchStatement',
  'StaticBlock',
  ...FUNCTION_NODES,
]);

/** Type-only wrappers around a runtime expression. */
const TS_WRAPPERS = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'ParenthesizedExpression',
]);

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { type?: unknown }).type === 'string';

const flag = (node: Node, key: 'computed' | 'declare'): boolean =>
  (node as unknown as Record<string, unknown>)[key] === true;

/** Child keys of `node` that hold runtime values (identifiers in name positions are skipped). */
function valueKeys(node: Node): readonly string[] {
  const keys = VISITOR_KEYS[node.type] ?? [];
  if (node.type === 'MetaProperty') return [];
  return keys.filter((key) => {
    if (TYPE_KEYS.has(key)) return false;
    if (key === 'property' && !flag(node, 'computed')) {
      return node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression';
    }
    if (key === 'key' && KEYED_NODES.has(node.type)) return flag(node, 'computed');
    if (key === 'label') return false;
    if (node.type === 'ExportSpecifier') return key === 'local';
    if (node.type === 'TSEnumMember') return key !== 'id';
    return true;
  });
}

/** `scopes` lists the scope nodes around `node`, outermost first, excluding `node` itself. */
type Visitor = (node: Node, ancestors: readonly Node[], scopes: readonly Node[]) => boolean;

/** Depth-first walk over runtime syntax; the visitor returns false to skip a node's children. */
function walk(root: Node, visit: Visitor): void {
  const ancestors: Node[] = [];
  const scopes: Node[] = [];
  const go = (node: Node): void => {
    if (TYPE_ONLY_NODES.has(node.type) || flag(node, 'declare')) return;
    if (!visit(node, ancestors, scopes)) return;
    const scoped = SCOPE_NODES.has(node.type);
    ancestors.push(node);
    if (scoped) scopes.push(node);
    for (const key of valueKeys(node)) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) if (isNode(item)) go(item);
      } else if (isNode(child)) {
        go(child);
      }
    }
    if (scoped) scopes.pop();
    ancestors.pop();
  };
  go(root);
}

/** `node` without type-only wrappers (`x as T`, `x!`, `(x)`). */
function unwrap(node: Node | null | undefined): Node | null | undefined {
  let current = node;
  while (current && TS_WRAPPERS.has(current.type)) {
    current = (current as Node & { expression: Node }).expression;
  }
  return current;
}

/** The module a `require('m')` / `await import('m')` initialiser loads, or null. */
function loadedModule(init: Node | null | undefined): string | null {
  const unwrapped = unwrap(init);
  const call = unwrapped?.type === 'AwaitExpression' ? unwrap(unwrapped.argument) : unwrapped;
  if (call?.type === 'ImportExpression' && call.source.type === 'StringLiteral') {
    return call.source.value;
  }
  if (
    call?.type === 'CallExpression' &&
    call.callee.type === 'Identifier' &&
    call.callee.name === 'require' &&
    call.arguments[0]?.type === 'StringLiteral'
  ) {
    return call.arguments[0].value;
  }
  return null;
}

const lineOf = (node: Node): number => node.loc?.start.line ?? 0;

/** Strips `node:` and maps `path/posix` to `path` so module checks see one name. */
const normaliseModule = (source: string): string => {
  const bare = source.startsWith('node:') ? source.slice('node:'.length) : source;
  return bare === 'path/posix' ? 'path' : bare;
};

const propertyName = (node: MemberExpression): string | null =>
  !node.computed && node.property.type === 'Identifier' ? node.property.name : null;

const keyName = (key: Node): string | null =>
  key.type === 'Identifier' ? key.name : key.type === 'StringLiteral' ? key.value : null;

/** Root identifier of a callee chain such as `it.concurrent.each(rows)`. */
function calleeRoot(node: Node): string | null {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression') return calleeRoot(node.object);
  if (node.type === 'CallExpression') return calleeRoot(node.callee);
  return null;
}

const isCreateRequireCall = (node: Node | null | undefined): node is CallExpression =>
  node?.type === 'CallExpression' &&
  ((node.callee.type === 'Identifier' && node.callee.name === 'createRequire') ||
    (node.callee.type === 'MemberExpression' && propertyName(node.callee) === 'createRequire'));

const toPosix = (value: string): string => value.split(path.sep).join('/');

/** True when POSIX `rel` is `dir` or inside it. */
const isWithin = (rel: string, dir: string): boolean => rel === dir || rel.startsWith(`${dir}/`);

/** True when POSIX `rel` is `dir` or one of its ancestors (`''` is the root). */
const contains = (rel: string, dir: string): boolean => rel === '' || isWithin(dir, rel);

const isInside = (abs: string, dir: string): boolean => {
  const rel = path.relative(dir, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** `@scope/name` or `name` of a bare specifier, or null when it is not a package specifier. */
function packageName(specifier: string): string | null {
  const segments = specifier.split('/');
  if (specifier.startsWith('@')) {
    return segments.length >= 2 && segments[1] !== '' ? `${segments[0]}/${segments[1]}` : null;
  }
  return segments[0] === '' || specifier.startsWith('#') ? null : segments[0];
}

// ── Module analysis ────────────────────────────────────────────────────────

interface AnalysisContext {
  packageDir: string;
  /** Read rules apply (the module is not production code). */
  testSide: boolean;
  /** Repo-relative display path. */
  display: (abs: string) => string;
}

/** Facts of one module: import edges, dynamic-import failures, read-rule hits and test API use. */
class ModuleAnalysis {
  private readonly scopeBindings = new Map<Node, Map<string, Binding[]>>();
  private readonly references = new Map<string, number>();
  private readonly values = new Map<Binding, Value>();
  private readonly evaluating = new Set<Binding>();
  private readonly skipped = new WeakSet<Node>();
  private readonly calleeCalls = new WeakSet<Node>();
  readonly facts: ModuleFacts = {
    edges: [],
    findings: [],
    reads: [],
    hooks: { beforeAll: 0, beforeEach: 0, afterAll: 0, afterEach: 0 },
    eachCalls: 0,
    testCalls: 0,
  };

  constructor(
    private readonly file: string,
    private readonly source: string,
    ast: File,
    private readonly context: AnalysisContext,
  ) {
    walk(ast.program, (node, ancestors, scopes) => this.collect(node, ancestors, scopes));
    walk(ast.program, (node, ancestors, scopes) => this.analyse(node, ancestors, scopes));
  }

  // Pass 1: bindings per scope, and value references.

  private bind(scope: Node | undefined, name: string, binding: Binding): void {
    if (!scope) return;
    let names = this.scopeBindings.get(scope);
    if (!names) {
      names = new Map();
      this.scopeBindings.set(scope, names);
    }
    const list = names.get(name);
    if (list) list.push(binding);
    else names.set(name, [binding]);
  }

  private bindPattern(scope: Node | undefined, pattern: Node | null | undefined): void {
    if (!pattern) return;
    switch (pattern.type) {
      case 'Identifier':
        this.bind(scope, pattern.name, { kind: 'other' });
        return;
      case 'ObjectPattern':
        for (const property of pattern.properties) {
          this.bindPattern(
            scope,
            property.type === 'RestElement' ? property.argument : property.value,
          );
        }
        return;
      case 'ArrayPattern':
        for (const element of pattern.elements) this.bindPattern(scope, element);
        return;
      case 'AssignmentPattern':
        this.bindPattern(scope, pattern.left);
        return;
      case 'RestElement':
        this.bindPattern(scope, pattern.argument);
        return;
      case 'TSParameterProperty':
        this.bindPattern(scope, pattern.parameter);
        return;
      default:
        return;
    }
  }

  private collect(node: Node, ancestors: readonly Node[], scopes: readonly Node[]): boolean {
    const current = scopes[scopes.length - 1];
    switch (node.type) {
      case 'ImportDeclaration':
        if (node.importKind !== 'type') {
          for (const specifier of node.specifiers) {
            if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') continue;
            this.bind(current, specifier.local.name, {
              kind: 'import',
              source: node.source.value,
              imported:
                specifier.type === 'ImportDefaultSpecifier'
                  ? 'default'
                  : specifier.type === 'ImportNamespaceSpecifier'
                    ? '*'
                    : (keyName(specifier.imported) ?? '*'),
            });
          }
        }
        return false;
      case 'TSImportEqualsDeclaration':
        if (node.moduleReference.type === 'TSExternalModuleReference') {
          this.bind(current, node.id.name, {
            kind: 'import',
            source: node.moduleReference.expression.value,
            imported: '*',
          });
        }
        return false;
      case 'ExportAllDeclaration':
        return false;
      case 'ExportNamedDeclaration':
        return !node.source;
      case 'Identifier':
        this.references.set(node.name, (this.references.get(node.name) ?? 0) + 1);
        return true;
      case 'VariableDeclarator': {
        const declaration = ancestors[ancestors.length - 1];
        const kind = declaration?.type === 'VariableDeclaration' ? declaration.kind : 'var';
        const scope =
          kind === 'var'
            ? [...scopes].reverse().find((s) => s.type === 'Program' || FUNCTION_NODES.has(s.type))
            : current;
        const loaded = loadedModule(node.init);
        if (node.id.type === 'Identifier') {
          this.bind(
            scope,
            node.id.name,
            kind === 'const' ? { kind: 'const', init: node.init, scopes: [...scopes] } : OTHER,
          );
        } else if (node.id.type === 'ObjectPattern' && loaded !== null) {
          for (const property of node.id.properties) {
            const name =
              property.type === 'ObjectProperty' && !property.computed
                ? keyName(property.key)
                : null;
            if (property.type === 'ObjectProperty' && name !== null) {
              if (property.value.type === 'Identifier') {
                this.bind(scope, property.value.name, {
                  kind: 'import',
                  source: loaded,
                  imported: name,
                });
              } else {
                this.bindPattern(scope, property.value);
              }
            } else {
              this.bindPattern(
                scope,
                property.type === 'RestElement' ? property.argument : property,
              );
            }
          }
        } else {
          this.bindPattern(scope, node.id);
        }
        return true;
      }
      case 'ClassDeclaration':
      case 'TSEnumDeclaration':
        if (node.id?.type === 'Identifier') this.bind(current, node.id.name, OTHER);
        return true;
      case 'CatchClause':
        this.bindPattern(node, node.param);
        return true;
      default:
        if (FUNCTION_NODES.has(node.type)) {
          const fn = node as Node & { id?: Node | null; params: readonly Node[] };
          this.bindPattern(node.type === 'FunctionDeclaration' ? current : node, fn.id);
          for (const param of fn.params) this.bindPattern(node, param);
        }
        return true;
    }
  }

  /** The binding `name` resolves to from a position inside `scopes` (outermost first). */
  private lookup(name: string, scopes: readonly Node[]): Binding | 'global' | 'ambiguous' {
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      const list = this.scopeBindings.get(scopes[index])?.get(name);
      if (list) return list.length === 1 ? list[0] : 'ambiguous';
    }
    return 'global';
  }

  /** The module and export an identifier stands for, when its binding is import-like. */
  private refersTo(
    name: string,
    scopes: readonly Node[],
  ): { module: string; imported: string } | null {
    const binding = this.lookup(name, scopes);
    if (typeof binding === 'string') return null;
    if (binding.kind === 'import') {
      return { module: normaliseModule(binding.source), imported: binding.imported };
    }
    if (binding.kind === 'const') {
      const loaded = loadedModule(binding.init);
      return loaded === null ? null : { module: normaliseModule(loaded), imported: '*' };
    }
    return null;
  }

  private isModuleObject(node: Node, modules: ReadonlySet<string>, scopes: readonly Node[]) {
    if (node.type !== 'Identifier') return false;
    const target = this.refersTo(node.name, scopes);
    return (
      target !== null &&
      modules.has(target.module) &&
      (target.imported === '*' || target.imported === 'default')
    );
  }

  // Static evaluation.

  private evaluateIdentifier(name: string, scopes: readonly Node[]): Value {
    const binding = this.lookup(name, scopes);
    if (binding === 'global') {
      if (name === '__dirname') return file(path.dirname(this.file));
      if (name === '__filename') return file(this.file);
      return UNKNOWN;
    }
    if (binding === 'ambiguous' || binding.kind !== 'const') return UNKNOWN;
    const cached = this.values.get(binding);
    if (cached) return cached;
    if (this.evaluating.has(binding)) return UNKNOWN;
    this.evaluating.add(binding);
    const value = this.evaluate(binding.init, binding.scopes);
    this.evaluating.delete(binding);
    this.values.set(binding, value);
    return value;
  }

  /** `path`/`url` function a callee names, or `cwd` for `process.cwd`. */
  private pathFunction(callee: Node, scopes: readonly Node[]): string | null {
    if (callee.type === 'Identifier') {
      const target = this.refersTo(callee.name, scopes);
      return target && (target.module === 'path' || target.module === 'url')
        ? target.imported
        : null;
    }
    if (callee.type !== 'MemberExpression') return null;
    const name = propertyName(callee);
    if (name === null) return null;
    const object = callee.object;
    if (
      object.type === 'Identifier' &&
      object.name === 'process' &&
      this.lookup('process', scopes) === 'global'
    ) {
      return name === 'cwd' ? 'cwd' : null;
    }
    if (this.isModuleObject(object, PATH_MODULES, scopes)) return name;
    if (
      object.type === 'MemberExpression' &&
      propertyName(object) === 'posix' &&
      this.isModuleObject(object.object, PATH_ONLY, scopes)
    ) {
      return name;
    }
    return null;
  }

  private evaluate(node: Node | null | undefined, scopes: readonly Node[]): Value {
    if (!node) return UNKNOWN;
    switch (node.type) {
      case 'StringLiteral':
        return text(node.value);
      case 'TemplateLiteral': {
        const parts: Value[] = [];
        node.quasis.forEach((quasi, index) => {
          parts.push(quasi.value.cooked == null ? UNKNOWN : text(quasi.value.cooked));
          const expression = node.expressions[index];
          if (expression) parts.push(this.evaluate(expression, scopes));
        });
        return this.concat(parts);
      }
      case 'BinaryExpression':
        return node.operator === '+'
          ? this.concat([this.evaluate(node.left, scopes), this.evaluate(node.right, scopes)])
          : UNKNOWN;
      case 'Identifier':
        return this.evaluateIdentifier(node.name, scopes);
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
      case 'TSTypeAssertion':
      case 'ParenthesizedExpression':
        return this.evaluate(node.expression, scopes);
      case 'MemberExpression':
        return this.evaluateMember(node, scopes);
      case 'CallExpression':
        return this.evaluateCall(node, scopes);
      case 'NewExpression':
        return this.evaluateNew(node, scopes);
      default:
        return UNKNOWN;
    }
  }

  private evaluateMember(node: MemberExpression, scopes: readonly Node[]): Value {
    const name = propertyName(node);
    if (
      node.object.type === 'MetaProperty' &&
      node.object.meta.name === 'import' &&
      node.object.property.name === 'meta'
    ) {
      if (name === 'url') return file(this.file, true);
      if (name === 'filename') return file(this.file);
      if (name === 'dirname') return file(path.dirname(this.file));
      return UNKNOWN;
    }
    if (
      (name === 'sep' || name === 'delimiter') &&
      this.isModuleObject(node.object, PATH_ONLY, scopes)
    ) {
      return text(name === 'sep' ? path.sep : path.delimiter);
    }
    const object = this.evaluate(node.object, scopes);
    if (object.kind !== 'file' || !object.url) return UNKNOWN;
    if (name === 'href') return object;
    if (name === 'pathname') return { ...object, url: false };
    return UNKNOWN;
  }

  private evaluateCall(node: CallExpression, scopes: readonly Node[]): Value {
    if (
      node.callee.type === 'MemberExpression' &&
      propertyName(node.callee) === 'toString' &&
      node.arguments.length === 0
    ) {
      const object = this.evaluate(node.callee.object, scopes);
      return object.kind === 'file' && object.url ? object : UNKNOWN;
    }
    const fn = this.pathFunction(node.callee, scopes);
    if (fn === null) return UNKNOWN;
    const args = node.arguments.map((arg) => this.evaluate(arg, scopes));
    switch (fn) {
      case 'cwd':
        return file(this.context.packageDir);
      case 'join':
        return this.combine(args, 'join');
      case 'resolve':
        return this.combine(args, 'resolve');
      case 'normalize':
        return args[0]?.kind === 'text'
          ? text(path.normalize(args[0].text))
          : args[0]?.kind === 'file' && !args[0].url
            ? { ...args[0], abs: path.normalize(args[0].abs) }
            : UNKNOWN;
      case 'dirname': {
        const arg = args[0];
        if (arg?.kind === 'text') return text(path.dirname(arg.text));
        if (arg?.kind !== 'file') return UNKNOWN;
        return arg.exact ? { ...arg, abs: path.dirname(arg.abs) } : arg;
      }
      case 'fileURLToPath':
        return args[0]?.kind === 'file' && args[0].url ? { ...args[0], url: false } : UNKNOWN;
      case 'pathToFileURL':
        return args[0]?.kind === 'file' && !args[0].url ? { ...args[0], url: true } : UNKNOWN;
      default:
        return UNKNOWN;
    }
  }

  private isUrlConstructor(callee: Node, scopes: readonly Node[]): boolean {
    if (callee.type !== 'Identifier') return false;
    if (callee.name === 'URL' && this.lookup('URL', scopes) === 'global') return true;
    const target = this.refersTo(callee.name, scopes);
    return target?.module === 'url' && target.imported === 'URL';
  }

  private evaluateNew(node: NewExpression, scopes: readonly Node[]): Value {
    if (!this.isUrlConstructor(node.callee, scopes) || node.arguments.length !== 2) return UNKNOWN;
    const spec = this.evaluate(node.arguments[0], scopes);
    const base = this.evaluate(node.arguments[1], scopes);
    if (base.kind !== 'file' || !base.url) return UNKNOWN;
    if (!base.exact) return base;
    if (spec.kind === 'unknown') return { ...base, abs: path.dirname(base.abs), exact: false };
    if (spec.kind !== 'text' || /^[a-z][a-z0-9+.-]*:/i.test(spec.text)) return UNKNOWN;
    return file(path.resolve(path.dirname(base.abs), spec.text), true);
  }

  /** `path.join` / `path.resolve` over evaluated arguments. */
  private combine(parts: readonly Value[], mode: 'join' | 'resolve'): Value {
    let acc: Value | undefined;
    for (const part of parts) {
      if (acc?.kind === 'file' && !acc.exact) return acc;
      if (part.kind === 'unknown') {
        return acc?.kind === 'file' ? { ...acc, exact: false } : UNKNOWN;
      }
      if (part.kind === 'file') {
        if (part.url || (acc !== undefined && mode === 'join')) return UNKNOWN;
        acc = part;
      } else if (acc === undefined || (mode === 'resolve' && path.isAbsolute(part.text))) {
        acc = part;
      } else if (acc.kind === 'file') {
        acc = { ...acc, abs: path.join(acc.abs, part.text) };
      } else if (acc.kind === 'text') {
        acc = text(path.join(acc.text, part.text));
      }
    }
    if (acc === undefined) return mode === 'resolve' ? file(this.context.packageDir) : text('.');
    if (mode === 'resolve' && acc.kind === 'text' && !path.isAbsolute(acc.text)) {
      return file(path.resolve(this.context.packageDir, acc.text));
    }
    return acc;
  }

  /** String concatenation (templates and `+`). */
  private concat(parts: readonly Value[]): Value {
    let acc: Value = text('');
    for (const part of parts) {
      if (acc.kind === 'unknown' || (acc.kind === 'file' && !acc.exact)) return acc;
      if (part.kind === 'unknown') {
        if (acc.kind !== 'file') return UNKNOWN;
        const prefix = /[\\/]$/.test(acc.abs) ? acc.abs : path.dirname(acc.abs);
        return { ...acc, abs: path.normalize(prefix), exact: false };
      }
      if (part.kind === 'file') {
        if (acc.kind !== 'text' || acc.text !== '') return UNKNOWN;
        acc = part;
      } else {
        acc =
          acc.kind === 'file' ? { ...acc, abs: acc.abs + part.text } : text(acc.text + part.text);
      }
    }
    return acc.kind === 'file' && acc.exact ? { ...acc, abs: path.normalize(acc.abs) } : acc;
  }

  // Pass 2: edges, reads and test API.

  private snippet(node: Node): string {
    const raw = this.source.slice(node.start ?? 0, node.end ?? 0).replace(/\s+/g, ' ');
    return raw.length > 100 ? `${raw.slice(0, 97)}...` : raw;
  }

  private edge(specifier: string, line: number, names: readonly string[] | null): void {
    this.facts.edges.push({
      target: { kind: 'specifier', specifier, fromDir: path.dirname(this.file) },
      line,
      names,
    });
  }

  /** A load whose specifier is an expression; `base` is null when it is not statically known. */
  private loadEdge(
    arg: Node | undefined,
    base: string | null,
    node: Node,
    names: readonly string[] | null,
    scopes: readonly Node[],
  ): void {
    const line = lineOf(node);
    const value = arg ? this.evaluate(arg, scopes) : UNKNOWN;
    if (value.kind === 'text' && (base !== null || !value.text.startsWith('.'))) {
      this.facts.edges.push({
        target: {
          kind: 'specifier',
          specifier: value.text,
          fromDir: path.dirname(base ?? this.file),
        },
        line,
        names,
      });
    } else if (value.kind === 'file' && value.exact) {
      this.facts.edges.push({ target: { kind: 'file', abs: value.abs }, line, names });
    } else {
      this.facts.findings.push({
        reason: 'unresolvable dynamic import',
        line,
        detail: this.snippet(arg ?? node),
      });
    }
    if (arg) this.skipped.add(arg);
  }

  /** Names a `require()`/`import()` result is destructured into, or null for the whole module. */
  private destructuredNames(node: Node, ancestors: readonly Node[]): readonly string[] | null {
    let child = node;
    let index = ancestors.length - 1;
    while (
      index >= 0 &&
      (ancestors[index].type === 'AwaitExpression' || TS_WRAPPERS.has(ancestors[index].type))
    ) {
      child = ancestors[index];
      index -= 1;
    }
    const parent = ancestors[index];
    if (parent?.type === 'MemberExpression' && parent.object === child) {
      const name = propertyName(parent);
      return name === null ? null : [name];
    }
    if (parent?.type !== 'VariableDeclarator' || parent.init !== child) return null;
    if (parent.id.type !== 'ObjectPattern') return null;
    const names: string[] = [];
    for (const property of parent.id.properties) {
      const name = property.type === 'ObjectProperty' ? keyName(property.key) : null;
      if (name === null) return null;
      names.push(name);
    }
    return names;
  }

  private importDeclaration(node: ImportDeclaration): void {
    if (node.importKind === 'type') return;
    if (node.specifiers.length === 0) {
      this.edge(node.source.value, lineOf(node), []);
      return;
    }
    const used = node.specifiers.filter(
      (specifier) =>
        !(specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') &&
        (this.references.get(specifier.local.name) ?? 0) > 0,
    );
    if (used.length === 0) return;
    const names: string[] = [];
    for (const specifier of used) {
      if (specifier.type !== 'ImportSpecifier') {
        this.edge(node.source.value, lineOf(node), null);
        return;
      }
      names.push(keyName(specifier.imported) ?? '*');
    }
    this.edge(node.source.value, lineOf(node), names);
  }

  private reexport(node: ExportNamedDeclaration): void {
    if (!node.source || node.exportKind === 'type') return;
    const names: string[] = [];
    for (const specifier of node.specifiers) {
      if (specifier.type === 'ExportSpecifier') {
        if (specifier.exportKind !== 'type') names.push(keyName(specifier.local) ?? '*');
      } else {
        this.edge(node.source.value, lineOf(node), null);
        return;
      }
    }
    if (names.length > 0) this.edge(node.source.value, lineOf(node), names);
  }

  /** Base file of a `createRequire(...)` call, or null when it is not static. */
  private requireBase(call: CallExpression, scopes: readonly Node[]): string | null {
    const value = this.evaluate(call.arguments[0], scopes);
    return value.kind === 'file' && value.exact ? value.abs : null;
  }

  /** Load semantics of a call: the base its specifier resolves against, or null for none. */
  private loadCall(node: CallExpression, scopes: readonly Node[]): { base: string | null } | null {
    const callee = node.callee;
    if (callee.type === 'Identifier') {
      const binding = this.lookup(callee.name, scopes);
      if (binding === 'global') return callee.name === 'require' ? { base: this.file } : null;
      const init = typeof binding === 'string' || binding.kind !== 'const' ? null : binding;
      const call = init ? unwrap(init.init) : null;
      return init && isCreateRequireCall(call)
        ? { base: this.requireBase(call, init.scopes) }
        : null;
    }
    if (isCreateRequireCall(callee)) return { base: this.requireBase(callee, scopes) };
    if (
      callee.type !== 'MemberExpression' ||
      callee.object.type !== 'Identifier' ||
      callee.object.name !== 'vi'
    ) {
      return null;
    }
    switch (propertyName(callee)) {
      case 'importActual':
      case 'importMock':
        return { base: this.file };
      case 'mock':
      case 'doMock': {
        const factory = node.arguments[1];
        const loadsOriginal =
          !factory ||
          !FUNCTION_NODES.has(factory.type) ||
          (factory as Node & { params: readonly Node[] }).params.length > 0;
        return loadsOriginal ? { base: this.file } : null;
      }
      default:
        return null;
    }
  }

  private isFsCall(callee: Node, scopes: readonly Node[]): boolean {
    if (callee.type === 'Identifier') {
      const target = this.refersTo(callee.name, scopes);
      return target !== null && FS_MODULES.has(target.module) && target.imported !== '*';
    }
    if (callee.type !== 'MemberExpression') return false;
    const object = callee.object;
    return (
      this.isModuleObject(object, FS_MODULES, scopes) ||
      (object.type === 'MemberExpression' &&
        propertyName(object) === 'promises' &&
        this.isModuleObject(object.object, FS_MODULES, scopes))
    );
  }

  private countTestApi(node: CallExpression): void {
    const callee = node.callee;
    if (callee.type === 'Identifier') {
      const hook = HOOK_NAMES.find((name) => name === callee.name);
      if (hook) this.facts.hooks[hook] += 1;
    }
    if (callee.type === 'CallExpression') this.calleeCalls.add(callee);
    if (callee.type === 'MemberExpression') {
      const name = propertyName(callee);
      const root = calleeRoot(callee.object);
      if ((name === 'each' || name === 'for') && root !== null && EACH_ROOTS.has(root)) {
        this.facts.eachCalls += 1;
      }
    }
    const root = calleeRoot(callee);
    if (root !== null && TEST_ROOTS.has(root) && !this.calleeCalls.has(node)) {
      this.facts.testCalls += 1;
    }
  }

  private recordRead(node: Node, abs: string, exact: boolean): void {
    const rel = toPosix(path.relative(this.context.packageDir, abs));
    let reason: string | null = null;
    if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
      // A prefix above the package may still end inside it.
      reason =
        !exact && isInside(this.context.packageDir, abs)
          ? 'unresolvable file path'
          : 'reads source outside gitnexus/';
    } else if (isWithin(rel, 'src')) {
      reason = 'reads source under src/';
    } else {
      const ignored = DEFAULT_IGNORED_DIRS.find((dir) => isWithin(rel, dir));
      if (ignored === 'test/fixtures') reason = 'reads test fixtures';
      else if (ignored !== undefined) reason = `reads ignored dir: ${ignored}/`;
      else if (!exact && ['src', ...DEFAULT_IGNORED_DIRS].some((dir) => contains(rel, dir))) {
        reason = 'unresolvable file path';
      }
    }
    if (reason !== null) {
      this.facts.reads.push({
        reason,
        line: lineOf(node),
        detail: `${this.snippet(node)} -> ${this.context.display(abs)}${exact ? '' : '/...'}`,
      });
    }
  }

  /** Read rule (a): evaluates an anchored path expression; returns false when it was decided. */
  private pathExpression(node: Node, scopes: readonly Node[]): boolean {
    const value = this.evaluate(node, scopes);
    if (value.kind !== 'file') return value.kind === 'unknown';
    this.recordRead(node, value.abs, value.exact);
    return false;
  }

  private isPathExpression(node: Node, scopes: readonly Node[]): boolean {
    switch (node.type) {
      case 'Identifier':
      case 'MemberExpression':
      case 'TemplateLiteral':
        return true;
      case 'BinaryExpression':
        return node.operator === '+';
      case 'NewExpression':
        return this.isUrlConstructor(node.callee, scopes);
      case 'CallExpression':
        return (
          this.pathFunction(node.callee, scopes) !== null ||
          (node.callee.type === 'MemberExpression' && propertyName(node.callee) === 'toString')
        );
      default:
        return false;
    }
  }

  private analyse(node: Node, ancestors: readonly Node[], scopes: readonly Node[]): boolean {
    if (this.skipped.has(node)) return false;
    switch (node.type) {
      case 'ImportDeclaration':
        this.importDeclaration(node);
        return false;
      case 'ExportNamedDeclaration':
        if (!node.source) return true;
        this.reexport(node);
        return false;
      case 'ExportAllDeclaration':
        if (node.exportKind !== 'type') this.edge(node.source.value, lineOf(node), null);
        return false;
      case 'TSImportEqualsDeclaration':
        if (
          node.importKind !== 'type' &&
          node.moduleReference.type === 'TSExternalModuleReference' &&
          (this.references.get(node.id.name) ?? 0) > 0
        ) {
          this.edge(node.moduleReference.expression.value, lineOf(node), null);
        }
        return false;
      case 'ImportExpression':
        this.loadEdge(
          node.source,
          this.file,
          node,
          this.destructuredNames(node, ancestors),
          scopes,
        );
        return false;
      case 'CallExpression': {
        this.countTestApi(node);
        const load = this.loadCall(node, scopes);
        if (load) {
          const arg = node.arguments[0];
          this.loadEdge(arg, load.base, node, this.destructuredNames(node, ancestors), scopes);
        }
        if (!this.context.testSide) return true;
        const first = node.arguments[0];
        if (first && this.isFsCall(node.callee, scopes)) {
          const value = this.evaluate(first, scopes);
          if (value.kind === 'text' && !path.isAbsolute(value.text) && !value.text.includes(':')) {
            this.recordRead(first, path.resolve(this.context.packageDir, value.text), true);
          }
        }
        return this.isPathExpression(node, scopes) ? this.pathExpression(node, scopes) : true;
      }
      default:
        if (this.context.testSide && this.isPathExpression(node, scopes)) {
          return this.pathExpression(node, scopes);
        }
        return true;
    }
  }
}

// ── Classifier ─────────────────────────────────────────────────────────────

const PARSER_PLUGINS: NonNullable<ParserOptions['plugins']> = ['typescript', 'decorators-legacy'];

function parseModule(abs: string, source: string): File {
  const ext = path.extname(abs);
  return parse(source, {
    sourceType: ext === '.cjs' || ext === '.cts' ? 'commonjs' : 'module',
    plugins: ext === '.tsx' || ext === '.jsx' ? [...PARSER_PLUGINS, 'jsx'] : PARSER_PLUGINS,
    errorRecovery: false,
  });
}

const emptyFacts = (finding: Finding): ModuleFacts => ({
  edges: [],
  findings: [finding],
  reads: [],
  hooks: { beforeAll: 0, beforeEach: 0, afterAll: 0, afterEach: 0 },
  eachCalls: 0,
  testCalls: 0,
});

const reject = (reason: string, detail: string): Resolved => ({ kind: 'reject', reason, detail });

/** Native hit of a package: the native package, the dependency chain to it and why. */
interface NativeHit {
  pkg: string;
  chain: string[];
  why: string;
}

/** Classifies test files of one repo checkout; caches parsed modules and resolutions. */
export class Classifier {
  readonly packageDir: string;
  private readonly sharedDir: string;
  private readonly sharedSrcDir: string;
  private readonly productionDirs: readonly string[];
  private readonly factsCache = new Map<string, ModuleFacts>();
  private readonly resolutions = new Map<string, Resolved>();
  private readonly kinds = new Map<string, 'file' | 'dir' | null>();
  private readonly directNative = new Map<string, string | null>();
  private readonly packageNative = new Map<string, NativeHit | null>();
  private sharedExports: ReadonlyMap<string, string> | undefined;

  constructor(readonly repoRoot: string) {
    this.packageDir = path.join(repoRoot, 'gitnexus');
    this.sharedDir = path.join(repoRoot, SHARED_PACKAGE);
    this.sharedSrcDir = path.join(this.sharedDir, 'src');
    this.productionDirs = [path.join(this.packageDir, 'src'), this.sharedSrcDir];
  }

  private display(abs: string): string {
    return isInside(abs, this.repoRoot) ? toPosix(path.relative(this.repoRoot, abs)) : abs;
  }

  private kind(abs: string): 'file' | 'dir' | null {
    let kind = this.kinds.get(abs);
    if (kind === undefined) {
      const stat = statSync(abs, { throwIfNoEntry: false });
      kind = stat?.isFile() ? 'file' : stat?.isDirectory() ? 'dir' : null;
      this.kinds.set(abs, kind);
    }
    return kind;
  }

  private facts(abs: string): ModuleFacts {
    const cached = this.factsCache.get(abs);
    if (cached) return cached;
    let facts: ModuleFacts;
    try {
      const source = readFileSync(abs, 'utf8');
      facts = new ModuleAnalysis(abs, source, parseModule(abs, source), {
        packageDir: this.packageDir,
        testSide: !this.productionDirs.some((dir) => isInside(abs, dir)),
        display: (target) => this.display(target),
      }).facts;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      facts = emptyFacts({ reason: 'parse error', line: 0, detail: message.split('\n')[0] });
    }
    this.factsCache.set(abs, facts);
    return facts;
  }

  // Resolution.

  private findFile(abs: string): string | null {
    if (this.kind(abs) === 'file') return abs;
    const ext = path.extname(abs);
    for (const tsExt of TS_FOR_JS[ext] ?? []) {
      const candidate = abs.slice(0, -ext.length) + tsExt;
      if (this.kind(candidate) === 'file') return candidate;
    }
    for (const appended of APPENDED_EXTENSIONS) {
      if (this.kind(abs + appended) === 'file') return abs + appended;
    }
    if (this.kind(abs) === 'dir') {
      for (const appended of APPENDED_EXTENSIONS) {
        const index = path.join(abs, `index${appended}`);
        if (this.kind(index) === 'file') return index;
      }
    }
    return null;
  }

  private locationReason(importer: string, target: string): string | null {
    if (isInside(importer, this.sharedSrcDir)) {
      const allowed =
        isInside(target, this.sharedSrcDir) || target === path.join(this.sharedDir, 'package.json');
      return allowed ? null : 'imports outside gitnexus/';
    }
    if (!isInside(target, this.packageDir)) return 'imports outside gitnexus/';
    const rel = toPosix(path.relative(this.packageDir, target));
    const ignored = DEFAULT_IGNORED_DIRS.find((dir) => isWithin(rel, dir));
    return ignored === undefined ? null : `imports from ignored dir: ${ignored}/`;
  }

  private resolveFile(importer: string, abs: string, shown: string, aliased: boolean): Resolved {
    const found = this.findFile(abs);
    if (found === null) return reject(`unresolved import: ${shown}`, `imports ${shown}`);
    if (found.endsWith('.node')) {
      return reject(`native binding: ${this.display(found)}`, `imports ${shown}`);
    }
    const location = aliased ? null : this.locationReason(importer, found);
    if (location !== null) {
      return reject(location, `imports ${shown} -> ${this.display(found)}`);
    }
    return WALKED_EXTENSIONS.has(path.extname(found)) && !found.endsWith('.d.ts')
      ? { kind: 'module', abs: found }
      : { kind: 'leaf', abs: found };
  }

  /** `exports` subpath of gitnexus-shared to its `src/` file (`./dist/X.js` -> `src/X.ts`). */
  private sharedExportMap(): ReadonlyMap<string, string> {
    if (this.sharedExports) return this.sharedExports;
    const map = new Map<string, string>();
    try {
      const manifest: unknown = JSON.parse(
        readFileSync(path.join(this.sharedDir, 'package.json'), 'utf8'),
      );
      const exportsField =
        typeof manifest === 'object' && manifest !== null && 'exports' in manifest
          ? manifest.exports
          : undefined;
      if (typeof exportsField === 'object' && exportsField !== null) {
        for (const [subpath, target] of Object.entries(exportsField)) {
          const resolved: unknown =
            typeof target === 'string'
              ? target
              : typeof target === 'object' && target !== null && 'default' in target
                ? target.default
                : undefined;
          const match = typeof resolved === 'string' ? /^\.\/dist\/(.+)\.js$/.exec(resolved) : null;
          if (match) map.set(subpath, path.join(this.sharedSrcDir, `${match[1]}.ts`));
        }
      }
    } catch {
      // A missing or broken manifest leaves the alias unresolved.
    }
    this.sharedExports = map;
    return map;
  }

  private findPackageDir(fromDir: string, name: string): string | null {
    let dir = fromDir;
    for (;;) {
      const candidate = path.join(dir, 'node_modules', name);
      if (this.kind(path.join(candidate, 'package.json')) === 'file') return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  private readManifest(dir: string): Record<string, unknown> {
    try {
      const data: unknown = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /** First `.node` file of a package, outside nested `node_modules`, in sorted order. */
  private findNodeBinary(dir: string, relative = ''): string | null {
    let entries;
    try {
      entries = readdirSync(path.join(dir, relative), { withFileTypes: true });
    } catch {
      return null;
    }
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of sorted) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isFile() && entry.name.endsWith('.node')) return child;
      if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
        const found = this.findNodeBinary(dir, child);
        if (found !== null) return found;
      }
    }
    return null;
  }

  /** Why a package itself is native, or null. */
  private nativeSelf(dir: string, name: string): string | null {
    const key = `${dir}\0${name}`;
    const cached = this.directNative.get(key);
    if (cached !== undefined) return cached;
    let why: string | null = null;
    if (KNOWN_NATIVE_PACKAGES.some((pattern) => pattern.test(name))) why = 'known native package';
    else if (this.readManifest(dir).gypfile === true) why = 'declares gypfile';
    else if (this.kind(path.join(dir, 'binding.gyp')) === 'file') why = 'has binding.gyp';
    else {
      const binary = this.findNodeBinary(dir);
      if (binary !== null) why = `ships ${binary}`;
    }
    this.directNative.set(key, why);
    return why;
  }

  /** Breadth-first over installed runtime dependencies; the first native package found. */
  private nativeOf(rootDir: string, rootName: string): NativeHit | null {
    const cached = this.packageNative.get(rootDir);
    if (cached !== undefined) return cached;
    const realOf = (dir: string): string => {
      try {
        return realpathSync(dir);
      } catch {
        return dir;
      }
    };
    const queue: { dir: string; name: string; chain: string[] }[] = [
      { dir: rootDir, name: rootName, chain: [rootName] },
    ];
    const seen = new Set([realOf(rootDir)]);
    let hit: NativeHit | null = null;
    for (let index = 0; index < queue.length && hit === null; index += 1) {
      const { dir, name, chain } = queue[index];
      const why = this.nativeSelf(dir, name);
      if (why !== null) {
        hit = { pkg: name, chain, why };
        break;
      }
      const manifest = this.readManifest(dir);
      const deps = new Set<string>();
      for (const field of ['dependencies', 'optionalDependencies']) {
        const value = manifest[field];
        if (typeof value === 'object' && value !== null) {
          for (const dep of Object.keys(value)) deps.add(dep);
        }
      }
      for (const dep of [...deps].sort()) {
        const depDir = this.findPackageDir(dir, dep);
        if (depDir === null || seen.has(realOf(depDir))) continue;
        seen.add(realOf(depDir));
        queue.push({ dir: depDir, name: dep, chain: [...chain, dep] });
      }
    }
    this.packageNative.set(rootDir, hit);
    return hit;
  }

  private resolveSpecifier(importer: string, specifier: string, fromDir: string): Resolved {
    if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
      if (/[?#]/.test(specifier)) {
        return reject(`unsupported import specifier: ${specifier}`, `imports ${specifier}`);
      }
      return this.resolveFile(importer, path.resolve(fromDir, specifier), specifier, false);
    }
    if (specifier.startsWith('file:')) {
      let abs: string;
      try {
        abs = fileURLToPath(specifier);
      } catch {
        return reject(`unresolved import: ${specifier}`, `imports ${specifier}`);
      }
      return this.resolveFile(importer, abs, specifier, false);
    }
    if (specifier.startsWith('node:') || BUILTINS.has(specifier)) {
      return { kind: 'builtin', name: normaliseModule(specifier) };
    }
    const name = packageName(specifier);
    if (name === null) return reject(`unresolved import: ${specifier}`, `imports ${specifier}`);
    if (name === SHARED_PACKAGE) {
      const subpath = specifier === name ? '.' : `.${specifier.slice(name.length)}`;
      const target = this.sharedExportMap().get(subpath);
      return target === undefined
        ? reject(`unresolved import: ${specifier}`, `imports ${specifier} (not in exports)`)
        : this.resolveFile(importer, target, specifier, true);
    }
    if (isHarnessPackage(name)) return { kind: 'package', name };
    if (KNOWN_NATIVE_PACKAGES.some((pattern) => pattern.test(name))) {
      return reject(`native package: ${name}`, `imports ${specifier} (known native package)`);
    }
    if (KNOWN_PROCESS_PACKAGES.some((pattern) => pattern.test(name))) {
      return reject(
        'spawns processes: child_process',
        `imports ${specifier} (the package loads node:child_process when imported)`,
      );
    }
    const dir = this.findPackageDir(fromDir, name);
    if (dir === null) {
      return reject(`unresolved import: ${specifier}`, `imports ${specifier} (not installed)`);
    }
    const native = this.nativeOf(dir, name);
    return native === null
      ? { kind: 'package', name }
      : reject(
          `native package: ${native.pkg}`,
          `imports ${specifier} (${native.chain.join(' -> ')}: ${native.why})`,
        );
  }

  private resolve(importer: string, target: EdgeTarget): Resolved {
    const zone = isInside(importer, this.sharedSrcDir) ? 'shared' : 'package';
    const key =
      target.kind === 'file'
        ? `${zone}\0file\0${target.abs}`
        : `${zone}\0${target.fromDir}\0${target.specifier}`;
    let resolved = this.resolutions.get(key);
    if (resolved === undefined) {
      resolved =
        target.kind === 'file'
          ? this.resolveFile(importer, target.abs, this.display(target.abs), false)
          : this.resolveSpecifier(importer, target.specifier, target.fromDir);
      this.resolutions.set(key, resolved);
    }
    return resolved;
  }

  // Closure walk.

  /** Classifies one package-relative test file. */
  classifyFile(testFile: string): FileVerdict {
    const testAbs = path.join(this.packageDir, testFile);
    const parents = new Map<string, string | null>([[testAbs, null]]);
    const queue = [testAbs];
    const closure = new Set<string>();
    const packages = new Set<string>();
    const builtins = new Set<string>();
    const evidence = new Map<string, Evidence>();
    const chain = (abs: string): string[] => {
      const via: string[] = [];
      for (let at: string | null | undefined = abs; at; at = parents.get(at)) {
        via.unshift(this.display(at));
      }
      return via;
    };
    const record = (module: string, finding: Finding): void => {
      if (evidence.has(finding.reason)) return;
      evidence.set(finding.reason, {
        reason: finding.reason,
        module: this.display(module),
        line: finding.line,
        detail: finding.detail,
        via: chain(module),
      });
    };
    if (this.kind(testAbs) !== 'file') {
      record(testAbs, { reason: 'parse error', line: 0, detail: 'test file not found' });
      queue.length = 0;
    }

    for (let index = 0; index < queue.length; index += 1) {
      const module = queue[index];
      closure.add(this.display(module));
      const facts = this.facts(module);
      for (const finding of facts.findings) record(module, finding);
      for (const finding of facts.reads) record(module, finding);
      for (const edge of facts.edges) {
        const resolved = this.resolve(module, edge.target);
        switch (resolved.kind) {
          case 'module':
            if (!parents.has(resolved.abs)) {
              parents.set(resolved.abs, module);
              queue.push(resolved.abs);
            }
            break;
          case 'leaf':
            closure.add(this.display(resolved.abs));
            break;
          case 'package':
            packages.add(resolved.name);
            break;
          case 'reject':
            record(module, { reason: resolved.reason, line: edge.line, detail: resolved.detail });
            break;
          case 'builtin':
            builtins.add(resolved.name);
            if (PROCESS_BUILTINS.has(resolved.name)) {
              record(module, {
                reason: `spawns processes: ${resolved.name}`,
                line: edge.line,
                detail: `imports node:${resolved.name}`,
              });
            }
            if (
              resolved.name === WORKER_BUILTIN &&
              (edge.names === null || edge.names.includes('Worker'))
            ) {
              record(module, {
                reason: `spawns workers: ${WORKER_BUILTIN}`,
                line: edge.line,
                detail: `imports ${edge.names === null ? 'all of' : 'Worker from'} node:${WORKER_BUILTIN}`,
              });
            }
            break;
        }
      }
    }

    const sortedEvidence = [...evidence.values()].sort((a, b) =>
      a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0,
    );
    const testFacts = this.kind(testAbs) === 'file' ? this.facts(testAbs) : undefined;
    return {
      file: testFile,
      status: sortedEvidence.length === 0 ? 'accepted' : 'rejected',
      reasons: sortedEvidence.map((entry) => entry.reason),
      evidence: sortedEvidence,
      hooks: {
        ...(testFacts?.hooks ?? { beforeAll: 0, beforeEach: 0, afterAll: 0, afterEach: 0 }),
      },
      eachCalls: testFacts?.eachCalls ?? 0,
      testCalls: testFacts?.testCalls ?? 0,
      closure: [...closure].sort(),
      packages: [...packages].sort(),
      builtins: [...builtins].sort(),
    };
  }
}

// ── Classification ─────────────────────────────────────────────────────────

/** Every `*.test.ts` file under a package-relative directory, package-relative and sorted. */
export function listTestFiles(packageDir: string, testRoot: string): string[] {
  const found: string[] = [];
  const visit = (relative: string): void => {
    for (const entry of readdirSync(path.join(packageDir, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory() && entry.name !== 'node_modules') visit(child);
      else if (entry.isFile() && entry.name.endsWith('.test.ts')) found.push(child);
    }
  };
  visit(testRoot.replace(/\/+$/, ''));
  return found.sort();
}

const countBy = (keys: readonly string[]): Record<string, number> => {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
};

const categoryOf = (reason: string): string => {
  const index = reason.indexOf(': ');
  return index === -1 ? reason : reason.slice(0, index);
};

/** Classifies the test files of a checkout; output order is deterministic (sorted by path). */
export function classify(options: ClassifyOptions): Classification {
  const classifier = new Classifier(options.repoRoot);
  const testRoot = options.testFiles ? null : (options.testRoot ?? 'test/unit');
  const testFiles = options.testFiles
    ? [...new Set(options.testFiles)].sort()
    : listTestFiles(classifier.packageDir, testRoot ?? 'test/unit');
  const files = testFiles.map((testFile) => classifier.classifyFile(testFile));
  const accepted = files.filter((verdict) => verdict.status === 'accepted');
  const rejected = files.filter((verdict) => verdict.status === 'rejected');
  return {
    schemaVersion: CLASSIFY_SCHEMA_VERSION,
    testRoot,
    files,
    accepted: accepted.map((verdict) => verdict.file),
    rejected: rejected.map(({ file: testFile, reasons }) => ({ file: testFile, reasons })),
    acceptedWithBeforeAll: accepted
      .filter((verdict) => verdict.hooks.beforeAll > 0)
      .map((verdict) => verdict.file),
    summary: {
      total: files.length,
      accepted: accepted.length,
      rejected: rejected.length,
      byReason: countBy(rejected.flatMap((verdict) => verdict.reasons)),
      byCategory: countBy(
        rejected.flatMap((verdict) => [...new Set(verdict.reasons.map(categoryOf))]),
      ),
    },
  };
}

/** Human-readable summary: counts, rejection categories and accepted files with `beforeAll`. */
export function renderSummary(result: Classification): string {
  const { summary } = result;
  const lines = [
    `classify: ${summary.total} test files: ${summary.accepted} accepted, ${summary.rejected} rejected`,
    'rejected files per reason category (a file counts once per category):',
    ...Object.entries(summary.byCategory).map(([category, count]) => `  ${category}: ${count}`),
    `accepted files with beforeAll: ${result.acceptedWithBeforeAll.length}`,
  ];
  const byFile = new Map(result.files.map((verdict) => [verdict.file, verdict]));
  for (const testFile of result.acceptedWithBeforeAll) {
    const verdict = byFile.get(testFile);
    lines.push(
      `  ${testFile} (beforeAll ${verdict?.hooks.beforeAll ?? 0}, test call sites ` +
        `${verdict?.testCalls ?? 0}, each ${verdict?.eachCalls ?? 0}, closure ` +
        `${verdict?.closure.length ?? 0} files)`,
    );
  }
  return lines.join('\n');
}

/** JSON form for the CLI; drops closure lists unless asked for. */
export function toJson(result: Classification, withClosure: boolean): string {
  const files = withClosure
    ? result.files
    : result.files.map(
        ({ closure: _closure, packages: _packages, builtins: _builtins, ...rest }) => rest,
      );
  return `${JSON.stringify({ ...result, files }, null, 2)}\n`;
}

// ── CLI ────────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const usage =
    'usage: node --import tsx tools/mutation/classify/classify.ts [--root <dir>] ' +
    '[--file <package-relative path>]... [--out <file.json>] [--closure]';
  let values: { root?: string; file?: string[]; out?: string; closure?: boolean };
  try {
    ({ values } = parseArgs({
      options: {
        root: { type: 'string' },
        file: { type: 'string', multiple: true },
        out: { type: 'string' },
        closure: { type: 'boolean', default: false },
      },
      strict: true,
    }));
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n${usage}`);
    process.exit(2);
  }
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  try {
    const result = classify({
      repoRoot,
      testFiles: values.file && values.file.length > 0 ? values.file : undefined,
      testRoot: values.root,
    });
    const json = toJson(result, values.closure === true);
    if (values.out) {
      writeFileSync(path.resolve(values.out), json);
      console.log(renderSummary(result));
    } else {
      process.stdout.write(json);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
