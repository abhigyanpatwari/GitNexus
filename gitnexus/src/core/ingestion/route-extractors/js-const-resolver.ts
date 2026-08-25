/**
 * JavaScript/TypeScript binding for the language-agnostic constant resolver.
 *
 * Supplies the two JS-specific pieces the shared fold in `constant-resolver.ts`
 * needs — {@link resolveJsImport} (import specifier → file key, honoring
 * relative paths, extensionless imports, directory `index` files and bare
 * alias-style specifiers) and {@link extractJsModuleFacts} (tree →
 * {@link ModuleConstants} plus the export/HTTP-client facts below) — mirroring
 * how `python-const-resolver.ts` binds the same core for Python (#2391).
 *
 * Two JS-shaped facts the Python binding has no analogue for:
 *
 *  1. **Object-literal path tables.** Python route constants are module-level
 *     scalars (`API_V1 = "/v1"`); the JS convention is one frozen table —
 *     `export const API_ROUTE_PATH = { LINKS: "/links", … } as const` — read at
 *     the call site as `API_ROUTE_PATH.LINKS`. The extractor flattens such a
 *     table into DOTTED literal keys (`API_ROUTE_PATH.LINKS` → `/links`) so the
 *     agnostic fold, which does a plain `literals.get(name)`, resolves a member
 *     reference with no changes to the core.
 *
 *  2. **Export aliasing.** `export default routeApiClient` and
 *     `export { a as b }` mean the name an importer writes is often not the
 *     name the defining file bound. {@link JsModuleFacts.exports} maps the
 *     EXPORTED name (including `default`) to the local one so a cross-file
 *     chase lands on the right binding.
 *
 * Both stay in this binding — the shared core keeps knowing nothing about any
 * language.
 *
 * Keying matches the Python binding: the repo map is keyed by unique POSIX file
 * path, and an import that cannot be pinned to exactly one file resolves to
 * `null` (skip) rather than an arbitrary winner. An unresolved path is a
 * missing contract; a wrongly-resolved one is a false cross-repo link, which is
 * strictly worse.
 */

import type Parser from 'tree-sitter';
import {
  MAX_FOLD_LENGTH,
  resolveConstant as foldConstant,
  type ImportResolver,
  type ModuleConstants,
  type Operand,
  type RepoConstants,
} from './constant-resolver.js';

export type {
  ImportBinding,
  ModuleConstants,
  Operand,
  RepoConstants,
} from './constant-resolver.js';

/** Extensions an extensionless JS/TS import may resolve to, in resolution order. */
const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'] as const;

/**
 * Bound on the re-export chase in {@link resolveJsMemberPath}. Mirrors the
 * fold's own `MAX_RESOLVE_DEPTH`: a barrel that re-exports through more hops
 * than this floors to `null` (skip), never to a guess.
 */
const MAX_REEXPORT_HOPS = 8;

/** The synthetic local name a bare `export default <expr>` binds to. */
const DEFAULT_LOCAL = '__default__';

/**
 * Per-file facts beyond the agnostic {@link ModuleConstants}: which exported
 * name maps to which local binding, and which local bindings hold an HTTP
 * client instance.
 */
export interface JsModuleFacts {
  /** String constants, dotted table members, `+`-expressions and imports. */
  readonly constants: ModuleConstants;
  /** Exported name (incl. `default`) → local binding name in this file. */
  readonly exports: Map<string, string>;
  /**
   * Module specifiers this file re-exports wholesale (`export * from './m'`).
   * A directory barrel is built almost entirely out of these, and a barrel is
   * what application code imports — so without following them, every name
   * reached through one resolves to nothing.
   */
  readonly starExports: string[];
  /**
   * Local names proven to hold an HTTP client INSTANCE — bound directly to
   * `axios.create(...)`, or to another local name that is one. Cross-file
   * chains are followed at query time by {@link isHttpClientRef}, not here.
   */
  readonly clients: Set<string>;
  /**
   * True when this file declares its own top-level binding named `axios` that
   * is NOT the axios module.
   *
   * The bare spelling `axios` is trusted without proof — it predates this
   * binding and is what the original query matched on. That is right for
   * `import axios from 'axios'` and for `const axios = require('axios')`, and
   * wrong for `const axios = fakeFactory`, where the spelling is the only
   * evidence and it is false. One flag, because the shortcut only ever applies
   * to this one name.
   */
  readonly axiosShadowed: boolean;
}

/**
 * Repo-wide facts, with everything the shared fold needs precomputed.
 *
 * `constants`, `keys` and `resolveImport` are derived from `byFile` and built
 * ONCE by {@link buildJsRepoFacts}, never per lookup: materializing a key set
 * at each call site makes every resolution O(files) and the whole scan
 * quadratic in a repo's file count. That was only half true before —
 * `resolveConstant` rebuilt its own key set on every fold regardless, so the
 * mitigation this comment describes was not in force for any resolution that
 * went through the shared core. It now takes `keys` as an argument.
 */
export interface JsRepoFacts {
  readonly byFile: ReadonlyMap<string, JsModuleFacts>;
  readonly constants: RepoConstants;
  readonly keys: ReadonlySet<string>;
  /**
   * {@link resolveJsImport} bound to a prebuilt basename index and memoized for
   * the lifetime of the facts. Every resolution inside this module goes through
   * it rather than the bare export: the widened consumer query matches every
   * `<identifier>.<verb>(…)` call in the repo, so an unindexed lookup ran once
   * per call site over every repo key.
   */
  readonly resolveImport: ImportResolver;
}

/**
 * Repo keys bucketed by final path segment.
 *
 * A tail lookup only ever matches keys whose last segment equals the
 * candidate's last segment, so the bucket is the entire search space — turning
 * an O(files) sweep per candidate into one map hit. `import-resolvers/utils.ts`
 * already ships `buildSuffixIndex` for the same job, but it keeps only a first
 * winner per suffix; this index has to SEE a collision to refuse it (below), so
 * it keeps the whole bucket.
 */
type BasenameIndex = ReadonlyMap<string, readonly string[]>;

function buildBasenameIndex(repoKeys: ReadonlySet<string>): BasenameIndex {
  const index = new Map<string, string[]>();
  for (const key of repoKeys) {
    const base = key.slice(key.lastIndexOf('/') + 1);
    const bucket = index.get(base);
    if (bucket) bucket.push(key);
    else index.set(base, [key]);
  }
  return index;
}

/** Build the {@link JsRepoFacts} projections from per-file facts. */
export function buildJsRepoFacts(byFile: ReadonlyMap<string, JsModuleFacts>): JsRepoFacts {
  const constants = new Map<string, ModuleConstants>();
  for (const [key, value] of byFile) constants.set(key, value.constants);
  const keys = new Set(byFile.keys());
  const index = buildBasenameIndex(keys);
  const memo = new Map<string, string | null>();
  const resolveImport: ImportResolver = (importingFileKey, moduleSpec, repoKeys) => {
    // Only the relative arm reads `importingFileKey`, but keying on both is a
    // string concat and keeps the memo correct if that ever stops being true.
    //
    // `repoKeys` is deliberately NOT part of the key: every caller inside this
    // module passes `facts.keys`, which is fixed for the lifetime of these
    // facts and is the set `index` was built from. A caller passing a different
    // set would get an answer computed against `facts.keys` — so don't.
    const memoKey = `${importingFileKey}\u0000${moduleSpec}`;
    const cached = memo.get(memoKey);
    if (cached !== undefined) return cached;
    const resolved = resolveImportWith(index, importingFileKey, moduleSpec, repoKeys);
    memo.set(memoKey, resolved);
    return resolved;
  };
  return { byFile, constants, keys, resolveImport };
}

function dirOf(fileKey: string): string {
  const slash = fileKey.lastIndexOf('/');
  return slash >= 0 ? fileKey.slice(0, slash) : '';
}

/** Collapse `a/b/../c` and `./` segments in a POSIX-ish path. */
function normalizePosix(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else out.push('..');
    } else {
      out.push(seg);
    }
  }
  return out.join('/');
}

/**
 * Candidate file keys for a module path with no extension: the path itself
 * (already-suffixed imports), each known extension, and the directory-`index`
 * forms. Order matters only for the relative case, where the first existing
 * candidate wins — matching bundler/`tsc` resolution order closely enough that
 * a repo with both `x.ts` and `x.js` picks the TypeScript source.
 */
function candidatesFor(modPath: string): string[] {
  const out = [modPath];
  for (const ext of JS_EXTENSIONS) out.push(`${modPath}${ext}`);
  for (const ext of JS_EXTENSIONS) out.push(`${modPath}/index${ext}`);
  return out;
}

/**
 * The MODULE a repo key denotes: the key without its extension, and without a
 * trailing `/index`.
 *
 * `x/routes.ts` and `x/routes/index.ts` are two spellings of the same module
 * `x/routes` — Node and `tsc` both pick the file over the directory, so a tail
 * matching both is not ambiguous, it just has a precedence order. Two
 * DIFFERENT identities sharing one tail is the real ambiguity, and that is what
 * {@link resolveImportWith} refuses.
 */
function moduleIdentityOf(key: string): string {
  for (const ext of JS_EXTENSIONS) {
    if (!key.endsWith(ext)) continue;
    const withoutExt = key.slice(0, -ext.length);
    return withoutExt.endsWith('/index') ? withoutExt.slice(0, -'/index'.length) : withoutExt;
  }
  return key;
}

/**
 * The JS/TS {@link ImportResolver}.
 *
 * Relative specifiers (`./api-routes`, `../shared/api-routes`) resolve against
 * the importing file's directory and must hit an existing key exactly.
 *
 * An alias-style specifier (`@/api-modules/shared/api-routes`, `~/x/y`) or a
 * multi-segment bare one is matched by UNIQUE PATH SUFFIX, the same strategy
 * the Python binding uses for absolute imports. This deliberately resolves
 * aliases without reading `tsconfig.json`: an alias prefix is arbitrary (`@/`,
 * `~/`, `#app/`, any `paths` key), but the segments AFTER it are a real path
 * tail, and matching that tail against the indexed file set answers the
 * question directly.
 *
 * Two rules keep that from inventing resolutions:
 *
 *  - **A tail claimed by two distinct modules returns `null`**, checked across
 *    EVERY candidate extension rather than within one. Returning on the first
 *    extension that matched let precedence pre-empt the guard, so a `.ts`/`.tsx`
 *    or `.ts`/`.js` collision — every Next.js repo — picked an arbitrary winner
 *    while this docstring promised a skip.
 *  - **A single-segment bare specifier never matches a repo file.** `axios`,
 *    `lodash` and the Node builtin `http` are npm/runtime modules, not ours to
 *    resolve; without this, a repo holding `src/lib/http.ts` "proved" that
 *    `import http from 'http'` was an axios client. An alias tail always has a
 *    sigil or a `/`, so this costs the feature nothing.
 */
function resolveImportWith(
  index: BasenameIndex,
  importingFileKey: string,
  moduleSpec: string,
  repoKeys: ReadonlySet<string>,
): string | null {
  if (moduleSpec === '') return null;

  if (moduleSpec.startsWith('./') || moduleSpec.startsWith('../')) {
    const base = dirOf(importingFileKey);
    const joined = normalizePosix(`${base}/${moduleSpec}`);
    // A `../` chain that climbs above the repo root leaves a leading `..`
    // segment; that import escapes the indexed tree and cannot be pinned.
    if (joined === '' || joined.startsWith('..')) return null;
    for (const candidate of candidatesFor(joined)) {
      if (repoKeys.has(candidate)) return candidate;
    }
    return null;
  }

  // Strip a leading alias sigil so `@/a/b` and `~/a/b` reduce to the tail
  // `a/b`. A scoped package (`@scope/pkg`) keeps its `@` and simply fails to
  // match any repo file below, which is the desired outcome.
  const aliased = /^[@~#]\//.test(moduleSpec);
  const tail = aliased ? moduleSpec.slice(2) : moduleSpec;
  if (tail === '' || tail.startsWith('.')) return null;
  if (!aliased && !tail.includes('/')) return null; // bare npm package / Node builtin

  let winner: string | null = null;
  let winnerRank = Number.POSITIVE_INFINITY;
  let identity: string | null = null;
  const candidates = candidatesFor(tail);
  for (let rank = 0; rank < candidates.length; rank++) {
    const candidate = candidates[rank];
    const bucket = index.get(candidate.slice(candidate.lastIndexOf('/') + 1));
    if (bucket === undefined) continue;
    for (const key of bucket) {
      if (key !== candidate && !key.endsWith(`/${candidate}`)) continue;
      const keyIdentity = moduleIdentityOf(key);
      if (identity === null) identity = keyIdentity;
      else if (identity !== keyIdentity) return null; // two modules share this tail
      if (rank < winnerRank) {
        winner = key;
        winnerRank = rank;
      }
    }
  }
  return winner;
}

/**
 * Standalone {@link ImportResolver} — the same rules as {@link resolveImportWith}
 * with the basename index built on the spot.
 *
 * Production goes through `JsRepoFacts.resolveImport`, which holds one index
 * for the whole repo and memoizes; this export exists so the resolution rules
 * can be exercised directly against a key set.
 */
export const resolveJsImport: ImportResolver = (importingFileKey, moduleSpec, repoKeys) =>
  resolveImportWith(buildBasenameIndex(repoKeys), importingFileKey, moduleSpec, repoKeys);

/** Unwrap TS `x as const` / `x satisfies T` to the underlying expression. */
function unwrapTsExpression(node: Parser.SyntaxNode): Parser.SyntaxNode {
  let cur = node;
  while (cur.type === 'as_expression' || cur.type === 'satisfies_expression') {
    const inner = cur.namedChild(0);
    if (!inner) break;
    cur = inner;
  }
  return cur;
}

/**
 * The literal string a node denotes, or `null` when it is not a plain literal.
 * A template string counts only when it has no `${…}` substitution — an
 * interpolated one is an expression, handled by {@link parseJsConstOperands}.
 */
function literalStringOf(node: Parser.SyntaxNode): string | null {
  const n = unwrapTsExpression(node);
  if (n.type === 'string') {
    const fragments = n.namedChildren.filter((c) => c.type === 'string_fragment');
    if (fragments.length === 0) return n.namedChildren.length === 0 ? '' : null;
    return fragments.map((f) => f.text).join('');
  }
  if (n.type === 'template_string') {
    if (n.namedChildren.some((c) => c.type === 'template_substitution')) return null;
    const fragments = n.namedChildren.filter((c) => c.type === 'string_fragment');
    return fragments.map((f) => f.text).join('');
  }
  return null;
}

/** The static key a property name node denotes (`FOO`, `'foo'`, `"foo"`). */
function staticKeyOf(node: Parser.SyntaxNode): string | null {
  if (node.type === 'property_identifier' || node.type === 'identifier') return node.text;
  if (node.type === 'string') return literalStringOf(node);
  return null;
}

/**
 * Flatten an object literal into dotted `prefix.KEY` → literal entries.
 * Nested objects recurse (`API.USERS.ME`); a computed key, a spread, or a
 * non-string value is skipped — the table's other entries stay usable.
 */
function flattenObjectLiteral(
  obj: Parser.SyntaxNode,
  prefix: string,
  into: Map<string, string>,
  depth = 0,
): void {
  if (depth > MAX_REEXPORT_HOPS) return;
  for (const pair of obj.namedChildren) {
    if (pair.type !== 'pair') continue;
    const keyNode = pair.childForFieldName('key');
    const valueNode = pair.childForFieldName('value');
    if (!keyNode || !valueNode) continue;
    const key = staticKeyOf(keyNode);
    if (key === null) continue;
    const value = unwrapTsExpression(valueNode);
    const literal = literalStringOf(value);
    if (literal !== null) {
      into.set(`${prefix}.${key}`, literal);
    } else if (value.type === 'object') {
      flattenObjectLiteral(value, `${prefix}.${key}`, into, depth + 1);
    }
  }
}

/**
 * Parse a `+`-concatenation / template string into an operand list the shared
 * fold can resolve, or `null` when a term is not a string literal or a
 * resolvable name reference.
 *
 * Handles the two shapes a JS route path is built with:
 *   `BASE + "/users"`            → [ref BASE, literal /users]
 *   `` `${BASE}/users/${id}` ``  → [ref BASE, literal /users/, ref id]
 *
 * A member reference inside either (`${API_ROUTE_PATH.LISTS}`) becomes a
 * dotted `ref`, which the flattened table above resolves directly.
 */
export function parseJsConstOperands(node: Parser.SyntaxNode, depth = 0): Operand[] | null {
  if (depth > MAX_EXPR_DEPTH) return null;
  const n = unwrapTsExpression(node);

  const literal = literalStringOf(n);
  if (literal !== null) return [{ kind: 'literal', value: literal }];

  if (n.type === 'identifier') return [{ kind: 'ref', name: n.text }];

  if (n.type === 'member_expression') {
    const dotted = dottedNameOf(n);
    return dotted === null ? null : [{ kind: 'ref', name: dotted }];
  }

  if (n.type === 'binary_expression') {
    const operator = n.childForFieldName('operator');
    if (operator?.text !== '+') return null;
    const left = n.childForFieldName('left');
    const right = n.childForFieldName('right');
    if (!left || !right) return null;
    const l = parseJsConstOperands(left, depth + 1);
    const r = parseJsConstOperands(right, depth + 1);
    return l === null || r === null ? null : [...l, ...r];
  }

  if (n.type === 'template_string') {
    const out: Operand[] = [];
    for (const child of n.namedChildren) {
      if (child.type === 'string_fragment') {
        out.push({ kind: 'literal', value: child.text });
      } else if (child.type === 'template_substitution') {
        const inner = child.namedChild(0);
        if (!inner) return null;
        const parsed = parseJsConstOperands(inner, depth + 1);
        if (parsed === null) return null;
        out.push(...parsed);
      }
    }
    return out;
  }

  return null;
}

/**
 * The dotted name a member expression denotes (`A.B.C`), or `null` for a
 * computed / non-identifier chain (`A[key]`, `fn().B`) that has no stable
 * textual key.
 */
export function dottedNameOf(node: Parser.SyntaxNode): string | null {
  const parts: string[] = [];
  let cur: Parser.SyntaxNode | null = node;
  while (cur && cur.type === 'member_expression') {
    const property = cur.childForFieldName('property');
    if (!property || property.type !== 'property_identifier') return null;
    parts.unshift(property.text);
    cur = cur.childForFieldName('object');
  }
  if (!cur || cur.type !== 'identifier') return null;
  parts.unshift(cur.text);
  return parts.join('.');
}

/**
 * How many wrapping calls {@link bindsAxiosClient} will look through. A factory
 * is one hop (`setupInterceptors(axios.create())`); a couple more costs nothing
 * and bounds the walk.
 */
const MAX_CLIENT_WRAP_DEPTH = 4;

/** True when a node is `axios.create(...)`, allowing an aliased axios import. */
function isAxiosCreateCall(
  node: Parser.SyntaxNode,
  imports: ReadonlyMap<string, { module: string; originalName: string }>,
  axiosShadowed: boolean,
): boolean {
  if (node.type !== 'call_expression') return false;
  const fn = node.childForFieldName('function');
  if (!fn || fn.type !== 'member_expression') return false;
  if (fn.childForFieldName('property')?.text !== 'create') return false;
  const object = fn.childForFieldName('object');
  if (!object || object.type !== 'identifier') return false;
  // `import axios from 'axios'` is the overwhelming convention, but the local
  // name is the importer's choice (`import ax from 'axios'`), so trust the
  // module specifier over the spelling whenever the file declares one. The
  // bare spelling is the fallback, and it is only evidence while the file has
  // not bound that name to something else.
  if (imports.get(object.text)?.module === 'axios') return true;
  return object.text === 'axios' && !axiosShadowed;
}

/** The module a `require('…')` initializer names, or `null` if it is not one. */
function requireSpecifierOf(node: Parser.SyntaxNode): string | null {
  const n = unwrapTsExpression(node);
  if (n.type !== 'call_expression') return null;
  if (n.childForFieldName('function')?.text !== 'require') return null;
  const args = n.childForFieldName('arguments');
  const first = args?.namedChild(0);
  return first ? literalStringOf(first) : null;
}

/**
 * Whether an initializer BINDS an axios instance — i.e. the instance is the
 * VALUE of the binding, not merely present somewhere inside it.
 *
 * A direct `const api = axios.create(...)` is the textbook form, but the shape
 * real applications ship is a factory that decorates the instance and hands it
 * back:
 *
 *   const routeApiClient = setupClientInterceptors({
 *     axiosInstance: axios.create({ baseURL: API_URL }),
 *   });
 *
 * Requiring the call to be the whole initializer would reject that — and it is
 * the single binding every call site in such an app goes through. So a wrapping
 * CALL whose result is bound counts, and the instance may be one of its
 * arguments or a property of a directly-passed object literal.
 *
 * What does NOT count is the instance being an INGREDIENT of the bound value.
 * The premise "an expression that builds an axios instance and binds the result
 * is an HTTP client" is only true when the instance is the result; a plain
 * subtree scan also admitted
 *
 *   const registry = { http: axios.create(), version: 'v1' };   // object literal
 *   const client   = MOCK ? memoryStore : axios.create();       // ternary branch
 *   new Map([['api', axios.create()]]);                         // constructor arg
 *   new LRUCache({ fetchMethod: axios.create().get });          // constructor arg
 *
 * and `.get`/`.delete` are the two most common non-HTTP method names in JS, so
 * every one of those made an ordinary cache or registry an HTTP consumer. Those
 * node types are simply not walked here.
 *
 * A nested function body is still skipped wherever it appears — a callback that
 * builds its own client does not vouch for the outer name.
 */
function bindsAxiosClient(
  node: Parser.SyntaxNode,
  imports: ReadonlyMap<string, { module: string; originalName: string }>,
  axiosShadowed: boolean,
  depth = 0,
): boolean {
  if (depth > MAX_CLIENT_WRAP_DEPTH) return false;
  const n = unwrapTsExpression(node);

  if (isAxiosCreateCall(n, imports, axiosShadowed)) return true;

  // Transparent wrappers around the value itself.
  if (
    n.type === 'await_expression' ||
    n.type === 'parenthesized_expression' ||
    n.type === 'non_null_expression'
  ) {
    const inner = n.namedChild(0);
    return inner !== null && bindsAxiosClient(inner, imports, axiosShadowed, depth + 1);
  }

  if (n.type !== 'call_expression') return false;

  const args = n.childForFieldName('arguments');
  if (!args) return false;
  for (const arg of args.namedChildren) {
    if (argumentHoldsAxiosClient(arg, imports, axiosShadowed, depth + 1)) return true;
  }
  return false;
}

/**
 * Whether a wrapping call's ARGUMENT carries the instance.
 *
 * Inside an argument the instance may sit in an options object at any nesting
 * (`createClient({ transport: { instance: axios.create() } })`) or in a list of
 * decorators (`compose([axios.create(), withAuth])`). That is safe because the
 * bound value is still the call's RESULT. It is the mirror of what
 * {@link bindsAxiosClient} refuses: an object, array, ternary or `new` as the
 * bound value itself never reaches here.
 */
function argumentHoldsAxiosClient(
  node: Parser.SyntaxNode,
  imports: ReadonlyMap<string, { module: string; originalName: string }>,
  axiosShadowed: boolean,
  depth: number,
): boolean {
  if (depth > MAX_CLIENT_WRAP_DEPTH) return false;
  const n = unwrapTsExpression(node);
  if (bindsAxiosClient(n, imports, axiosShadowed, depth)) return true;

  if (n.type === 'object') {
    for (const pair of n.namedChildren) {
      if (pair.type !== 'pair') continue;
      const value = pair.childForFieldName('value');
      if (value && argumentHoldsAxiosClient(value, imports, axiosShadowed, depth + 1)) return true;
    }
    return false;
  }

  if (n.type === 'array') {
    for (const element of n.namedChildren) {
      if (argumentHoldsAxiosClient(element, imports, axiosShadowed, depth + 1)) return true;
    }
  }
  return false;
}

/**
 * Record one `name = value` binding into the accumulating facts.
 * Shared by plain declarations and their `export const` form.
 */
function recordBinding(
  name: string,
  valueNode: Parser.SyntaxNode,
  literals: Map<string, string>,
  exprs: Map<string, readonly Operand[]>,
  clients: Set<string>,
  imports: ReadonlyMap<string, { module: string; originalName: string }>,
  axiosShadowed: boolean,
): void {
  const value = unwrapTsExpression(valueNode);

  if (bindsAxiosClient(value, imports, axiosShadowed)) {
    clients.add(name);
    return;
  }

  // `const client = someOtherClient` — an alias. Recorded as a client-chase
  // edge (below) and as a constant ref, since one of the two will resolve.
  if (value.type === 'identifier') {
    exprs.set(name, [{ kind: 'ref', name: value.text }]);
    return;
  }

  if (value.type === 'object') {
    flattenObjectLiteral(value, name, literals);
    return;
  }

  const literal = literalStringOf(value);
  if (literal !== null) {
    literals.set(name, literal);
    return;
  }

  const operands = parseJsConstOperands(value);
  if (operands !== null) exprs.set(name, operands);
}

/** Record every `variable_declarator` in a declaration node. */
function recordDeclaration(
  decl: Parser.SyntaxNode,
  literals: Map<string, string>,
  exprs: Map<string, readonly Operand[]>,
  clients: Set<string>,
  imports: ReadonlyMap<string, { module: string; originalName: string }>,
  axiosShadowed: boolean,
  exports: Map<string, string> | null,
): void {
  for (const declarator of decl.namedChildren) {
    if (declarator.type !== 'variable_declarator') continue;
    const nameNode = declarator.childForFieldName('name');
    const valueNode = declarator.childForFieldName('value');
    if (!nameNode || nameNode.type !== 'identifier' || !valueNode) continue;
    recordBinding(nameNode.text, valueNode, literals, exprs, clients, imports, axiosShadowed);
    exports?.set(nameNode.text, nameNode.text);
  }
}

/** Record one `import … from 'm'` statement's local bindings. */
function recordImportStatement(
  stmt: Parser.SyntaxNode,
  imports: Map<string, { module: string; originalName: string }>,
): void {
  const source = stmt.childForFieldName('source');
  const moduleSpec = source ? literalStringOf(source) : null;
  if (moduleSpec === null) return;
  for (const clause of stmt.namedChildren) {
    if (clause.type !== 'import_clause') continue;
    for (const spec of clause.namedChildren) {
      // `import Default from 'm'`
      if (spec.type === 'identifier') {
        imports.set(spec.text, { module: moduleSpec, originalName: 'default' });
      } else if (spec.type === 'namespace_import') {
        const alias = spec.namedChild(0);
        // `import * as NS from 'm'` — `NS.X` resolves to the target's `X`.
        if (alias) imports.set(alias.text, { module: moduleSpec, originalName: '*' });
      } else if (spec.type === 'named_imports') {
        for (const named of spec.namedChildren) {
          if (named.type !== 'import_specifier') continue;
          const nameNode = named.childForFieldName('name');
          const aliasNode = named.childForFieldName('alias');
          if (!nameNode) continue;
          const local = (aliasNode ?? nameNode).text;
          imports.set(local, { module: moduleSpec, originalName: nameNode.text });
        }
      }
    }
  }
}

/**
 * Extract one file's {@link JsModuleFacts} from its parsed tree.
 *
 * Only TOP-LEVEL declarations are collected. A route table or an API client
 * defined inside a function body is not a module constant, and treating it as
 * one would let an unrelated same-named local shadow the real export.
 */
export function extractJsModuleFacts(tree: Parser.Tree): JsModuleFacts {
  const literals = new Map<string, string>();
  const exprs = new Map<string, readonly Operand[]>();
  const imports = new Map<string, { module: string; originalName: string }>();
  const exports = new Map<string, string>();
  const starExports: string[] = [];
  const clients = new Set<string>();

  // Imports first. ES module bindings are hoisted — `const c = ax.create(…)`
  // above `import ax from 'axios'` is legal and binds the same `ax` — but
  // `bindsAxiosClient` consults `imports` as each declaration is recorded, so
  // in source order an import declared later was simply not there yet and the
  // client went unproven.
  //
  // CommonJS `const ax = require('axios')` is collected here too. It is the
  // same binding by another spelling, and without it an aliased require
  // resolved to nothing at all while the un-aliased one worked only because
  // `axios` happens to be the name the spelling shortcut trusts.
  let axiosShadowed = false;
  for (const stmt of tree.rootNode.namedChildren) {
    if (stmt.type === 'import_statement') {
      recordImportStatement(stmt, imports);
      continue;
    }
    const decl = stmt.type === 'export_statement' ? stmt.childForFieldName('declaration') : stmt;
    if (
      decl === null ||
      (decl.type !== 'lexical_declaration' && decl.type !== 'variable_declaration')
    ) {
      continue;
    }
    for (const declarator of decl.namedChildren) {
      if (declarator.type !== 'variable_declarator') continue;
      const nameNode = declarator.childForFieldName('name');
      const valueNode = declarator.childForFieldName('value');
      if (!nameNode || nameNode.type !== 'identifier') continue;
      const required = valueNode === null ? null : requireSpecifierOf(valueNode);
      if (required !== null) {
        imports.set(nameNode.text, { module: required, originalName: 'default' });
      } else if (nameNode.text === 'axios') {
        axiosShadowed = true;
      }
    }
  }

  for (const stmt of tree.rootNode.namedChildren) {
    if (stmt.type === 'lexical_declaration' || stmt.type === 'variable_declaration') {
      recordDeclaration(stmt, literals, exprs, clients, imports, axiosShadowed, null);
      continue;
    }

    if (stmt.type === 'import_statement') continue; // hoisted above

    if (stmt.type !== 'export_statement') continue;

    const source = stmt.childForFieldName('source');
    const reexportFrom = source ? literalStringOf(source) : null;
    const declaration = stmt.childForFieldName('declaration');
    const value = stmt.childForFieldName('value');

    // `export const X = …` / `export default <expr>`
    if (declaration) {
      if (
        declaration.type === 'lexical_declaration' ||
        declaration.type === 'variable_declaration'
      ) {
        recordDeclaration(declaration, literals, exprs, clients, imports, axiosShadowed, exports);
      }
      continue;
    }

    if (value) {
      // `export default routeApiClient` / `export default axios.create(...)`
      if (value.type === 'identifier') {
        exports.set('default', value.text);
      } else {
        recordBinding(DEFAULT_LOCAL, value, literals, exprs, clients, imports, axiosShadowed);
        exports.set('default', DEFAULT_LOCAL);
      }
      continue;
    }

    // `export * from './m'` / `export * as NS from './m'`. Neither has an
    // export_clause; the namespace form additionally binds a local alias.
    if (reexportFrom !== null && !stmt.namedChildren.some((c) => c.type === 'export_clause')) {
      const namespaceAlias = stmt.namedChildren.find((c) => c.type === 'namespace_export');
      const alias = namespaceAlias?.namedChild(0)?.text;
      if (alias !== undefined) {
        imports.set(alias, { module: reexportFrom, originalName: '*' });
        exports.set(alias, alias);
      } else {
        starExports.push(reexportFrom);
      }
      continue;
    }

    // `export { a, b as c }` and `export { a } from './m'`
    for (const clause of stmt.namedChildren) {
      if (clause.type !== 'export_clause') continue;
      for (const spec of clause.namedChildren) {
        if (spec.type !== 'export_specifier') continue;
        const nameNode = spec.childForFieldName('name');
        const aliasNode = spec.childForFieldName('alias');
        if (!nameNode) continue;
        const exported = (aliasNode ?? nameNode).text;
        if (reexportFrom !== null) {
          imports.set(exported, { module: reexportFrom, originalName: nameNode.text });
          exports.set(exported, exported);
        } else {
          exports.set(exported, nameNode.text);
        }
      }
    }
  }

  return { constants: { literals, exprs, imports }, exports, starExports, clients, axiosShadowed };
}

/**
 * Resolve a path reference at a call site to its literal string, or `null`.
 *
 * `ref` is the dotted name as written (`API_ROUTE_PATH.LINKS`, or a bare
 * `BASE_PATH`). Resolution order:
 *
 *   1. The dotted name as a constant of the CURRENT file — hits when the table
 *      is declared in the same file (flattened to dotted literal keys).
 *   2. The base name as an IMPORT of the current file — hop to the defining
 *      file and look the dotted name up there, re-hopping through barrels that
 *      re-export it, bounded by {@link MAX_REEXPORT_HOPS}.
 *
 * Returns `null` on anything it cannot fully fold, which leaves the call site
 * exactly as unmatched as it is today — never a guessed path.
 */
export function resolveJsMemberPath(
  fileKey: string,
  ref: string,
  facts: JsRepoFacts,
): string | null {
  const direct = foldConstant(fileKey, ref, facts.constants, facts.resolveImport, facts.keys);
  if (direct !== null) return direct;

  const dot = ref.indexOf('.');
  if (dot < 0) return null;
  const base = ref.slice(0, dot);
  const member = ref.slice(dot + 1);

  const binding = facts.byFile.get(fileKey)?.constants.imports.get(base);
  if (!binding) return null;
  const targetKey = facts.resolveImport(fileKey, binding.module, facts.keys);
  if (targetKey === null) return null;

  // `import * as NS from 'm'` — `NS.TABLE.KEY` addresses the target's own
  // `TABLE.KEY`, so the namespace alias drops out of the reference entirely.
  if (binding.originalName === '*') {
    const nextDot = member.indexOf('.');
    if (nextDot < 0) return null;
    return resolveExportedMember(
      targetKey,
      member.slice(0, nextDot),
      member.slice(nextDot + 1),
      facts,
      0,
      new Set(),
    );
  }

  return resolveExportedMember(targetKey, binding.originalName, member, facts, 0, new Set());
}

/**
 * Resolve `<exported>.<member>` against a module's PUBLIC surface, following
 * whatever indirection stands between the name and its definition.
 *
 * Three ways a module can expose a name, tried in order:
 *   1. it defines it (possibly under a different local name — `export { a as b }`)
 *   2. it re-exports it explicitly (`export { a } from './m'`)
 *   3. it re-exports a whole module (`export * from './m'`)
 *
 * The third is the one that matters in practice: application code imports a
 * DIRECTORY (`@/api-modules/shared`), whose `index.ts` is nothing but
 * `export * from './api-routes'`. Stopping at the barrel resolves nothing at
 * all, so the star edges have to be walked. `seen` makes mutually-importing
 * barrels terminate instead of recursing forever.
 */
function resolveExportedMember(
  fileKey: string,
  exported: string,
  member: string,
  facts: JsRepoFacts,
  depth: number,
  seen: Set<string>,
): string | null {
  if (depth > MAX_REEXPORT_HOPS) return null;
  const guard = `${fileKey}::${exported}.${member}`;
  if (seen.has(guard)) return null;
  seen.add(guard);

  const file = facts.byFile.get(fileKey);
  if (!file) return null;

  const local = file.exports.get(exported) ?? exported;
  const here = foldConstant(
    fileKey,
    `${local}.${member}`,
    facts.constants,
    facts.resolveImport,
    facts.keys,
  );
  if (here !== null) return here;

  const binding = file.constants.imports.get(exported);
  if (binding) {
    const targetKey = facts.resolveImport(fileKey, binding.module, facts.keys);
    if (targetKey !== null) {
      const viaImport = resolveExportedMember(
        targetKey,
        binding.originalName === '*' ? exported : binding.originalName,
        member,
        facts,
        depth + 1,
        seen,
      );
      if (viaImport !== null) return viaImport;
    }
  }

  // Every star edge is walked, not just up to the first hit: two barrels
  // re-exporting the same name is ambiguous in JS itself, so answering with
  // whichever module happens to come first in `starExports` would be a guess
  // dressed as a resolution.
  let viaStar: string | null = null;
  for (const spec of file.starExports) {
    const targetKey = facts.resolveImport(fileKey, spec, facts.keys);
    if (targetKey === null) continue;
    const found = resolveExportedMember(targetKey, exported, member, facts, depth + 1, seen);
    if (found === null) continue;
    if (viaStar !== null && viaStar !== found) return null;
    viaStar = found;
  }

  return viaStar;
}

/** The local binding an exported name refers to in `fileKey` (identity if unaliased). */
function resolveExportLocal(facts: JsRepoFacts, fileKey: string, exported: string): string {
  return facts.byFile.get(fileKey)?.exports.get(exported) ?? exported;
}

/**
 * Recursion ceiling for the path-expression fold, and the matching term cap for
 * a `+` chain.
 *
 * Nothing on this path was bounded before: `flattenConcat` recursed once per
 * term, mutually with {@link foldTermOrPlaceholder}, on the SCAN side — which
 * `prepareRepo`'s `try/catch` does not cover and which `HttpLanguagePlugin.scan`
 * contractually may not throw from. ~6 400 concat terms (38 KB of source) threw
 * `RangeError: Maximum call stack size exceeded` out of `extract()`, and
 * `sync.ts` turns that into an unexplained "missing repo" with every contract of
 * every kind — HTTP, gRPC, topics, includes — dropped for that repo and nothing
 * logged. A hand-written route path is a handful of terms.
 */
const MAX_EXPR_DEPTH = 64;
const MAX_CONCAT_TERMS = 256;

/** One folded term, and whether its text is KNOWN rather than a placeholder. */
interface FoldedTerm {
  readonly text: string;
  readonly concrete: boolean;
}

/**
 * A folded path expression, and whether its FIRST term was concrete.
 *
 * `anchored` is what separates a partially-folded path from a fabricated one.
 * `${API_ROUTE_PATH.LISTS}/${eventId}/add` is anchored — its leading segment is
 * a resolved route constant and the rest is honest `{param}`s. `${base}${suffix}`
 * and `${BASE}/users` are not: nothing pins where the path starts, so consumer
 * normalization squashes them to `/{param}{param}` and `/{param}/users`, which
 * exact-match real provider routes and invent cross-repo links. The docstring
 * on {@link resolveJsPathExpression} always claimed at least one literal segment
 * was required; only now is it true.
 */
interface FoldedPath {
  readonly text: string;
  readonly anchored: boolean;
}

/**
 * Resolve one term of a partially-foldable path, re-emitting it as a
 * `${…}` placeholder when it cannot be folded.
 *
 * The placeholder is deliberate, not a fallback wart: consumer-side path
 * normalization rewrites `${…}` to `{param}`, which is exactly the right
 * reading for a term that IS a runtime value (`${eventId}`). Re-emitting keeps
 * a mixed path like `` `${API_ROUTE_PATH.LISTS}/${eventId}/add` `` resolvable to
 * `/curator-lists/{param}/add` instead of collapsing its known prefix to
 * `{param}/{param}/add`.
 */
function foldTermOrPlaceholder(
  fileKey: string,
  node: Parser.SyntaxNode,
  facts: JsRepoFacts,
  depth: number,
): FoldedTerm | null {
  if (depth > MAX_EXPR_DEPTH) return null;
  const n = unwrapTsExpression(node);

  const literal = literalStringOf(n);
  if (literal !== null) return { text: literal, concrete: true };

  // A template nested inside a substitution — `` `${BASE}${`/${id}/unlike`}` ``
  // is a real shape. Recursing keeps its literal segments; emitting it verbatim
  // would collapse the whole inner template to one `{param}` and lose them.
  if (n.type === 'template_string' || n.type === 'binary_expression') {
    const nested = foldPathExpression(fileKey, n, facts, depth + 1);
    if (nested !== null) return { text: nested.text, concrete: nested.anchored };
  }

  const dotted = n.type === 'identifier' ? n.text : dottedNameOf(n);
  if (dotted !== null) {
    const resolved = resolveJsMemberPath(fileKey, dotted, facts);
    if (resolved !== null) return { text: resolved, concrete: true };
    return { text: `\${${dotted}}`, concrete: false };
  }

  return { text: `\${${n.text}}`, concrete: false };
}

/** Flatten a left-nested `a + b + c` chain into its terms, or `null` if not all `+`. */
function flattenConcat(node: Parser.SyntaxNode, depth: number): Parser.SyntaxNode[] | null {
  if (depth > MAX_EXPR_DEPTH) return null;
  const n = unwrapTsExpression(node);
  if (n.type !== 'binary_expression') return [n];

  // The LEFT spine is walked iteratively: `a + b + c + …` parses left-nested,
  // so recursing once per term is one stack frame per term. Only a `+` on the
  // right can still nest, and that recursion is depth-capped.
  const reversed: Parser.SyntaxNode[] = [];
  let cur: Parser.SyntaxNode = n;
  for (;;) {
    if (reversed.length > MAX_CONCAT_TERMS) return null;
    if (cur.childForFieldName('operator')?.text !== '+') return null;
    const left = cur.childForFieldName('left');
    const right = cur.childForFieldName('right');
    if (!left || !right) return null;
    reversed.push(right);
    const nextLeft = unwrapTsExpression(left);
    if (nextLeft.type !== 'binary_expression') {
      reversed.push(nextLeft);
      break;
    }
    cur = nextLeft;
  }

  const out: Parser.SyntaxNode[] = [];
  for (let i = reversed.length - 1; i >= 0; i--) {
    const term = reversed[i];
    if (unwrapTsExpression(term).type !== 'binary_expression') {
      out.push(term);
      continue;
    }
    const nested = flattenConcat(term, depth + 1);
    if (nested === null) return null;
    out.push(...nested);
    if (out.length > MAX_CONCAT_TERMS) return null;
  }
  return out;
}

/**
 * The fold behind {@link resolveJsPathExpression}, carrying the recursion depth
 * and reporting whether the result is anchored.
 *
 * `MAX_FOLD_LENGTH` is checked on the ACCUMULATED text, not per term. The
 * shared core caps each folded constant at that length; joining an unbounded
 * number of them made the cap a ~2048x amplifier instead of a ceiling (each
 * `${A}` costs 4 source characters and can yield 8 192), and the result is not
 * transient — it becomes `contractId` and `meta.path` in `contracts.json` and
 * `bridge.lbug`. Measured 200 KB of source to 941 MB of heap before this.
 */
function foldPathExpression(
  fileKey: string,
  node: Parser.SyntaxNode,
  facts: JsRepoFacts,
  depth: number,
): FoldedPath | null {
  if (depth > MAX_EXPR_DEPTH) return null;
  const n = unwrapTsExpression(node);

  const literal = literalStringOf(n);
  if (literal !== null) return { text: literal, anchored: true };

  if (n.type === 'identifier' || n.type === 'member_expression') {
    const dotted = n.type === 'identifier' ? n.text : dottedNameOf(n);
    if (dotted === null) return null;
    const resolved = resolveJsMemberPath(fileKey, dotted, facts);
    return resolved === null ? null : { text: resolved, anchored: true };
  }

  const terms: Parser.SyntaxNode[] = [];
  if (n.type === 'template_string') {
    for (const child of n.namedChildren) {
      if (child.type === 'string_fragment') {
        terms.push(child);
      } else if (child.type === 'template_substitution') {
        const inner = child.namedChild(0);
        if (inner === null) return null;
        terms.push(inner);
      }
    }
  } else if (n.type === 'binary_expression') {
    const flattened = flattenConcat(n, depth);
    if (flattened === null) return null;
    terms.push(...flattened);
  } else {
    return null;
  }

  let out = '';
  let anchored: boolean | null = null;
  for (const term of terms) {
    const folded =
      term.type === 'string_fragment'
        ? { text: term.text, concrete: true }
        : foldTermOrPlaceholder(fileKey, term, facts, depth + 1);
    if (folded === null) return null;
    if (anchored === null) anchored = folded.concrete;
    out += folded.text;
    if (out.length > MAX_FOLD_LENGTH) return null;
  }
  return anchored === null ? null : { text: out, anchored };
}

/**
 * Resolve the first argument of an HTTP call to a path string, or `null` when
 * the expression is not a path shape this binding understands.
 *
 * Accepts a plain literal, a constant reference (`BASE_PATH`), a table member
 * (`API_ROUTE_PATH.LINKS`), a template string, and a `+`-concatenation of any
 * of those. Template and concat forms fold PARTIALLY — see
 * {@link foldTermOrPlaceholder}.
 *
 * A reference that resolves to nothing returns `null` (skip), and so does a
 * mixed expression whose leading term is unresolved — see {@link FoldedPath}.
 */
export function resolveJsPathExpression(
  fileKey: string,
  node: Parser.SyntaxNode,
  facts: JsRepoFacts,
): string | null {
  const folded = foldPathExpression(fileKey, node, facts, 0);
  return folded !== null && folded.anchored ? folded.text : null;
}

/**
 * Whether `name`, as referenced in `fileKey`, holds an HTTP client instance.
 *
 * Chases local aliases and import/export hops so the common app shape —
 * `axios.create()` in `lib/axios.config.ts`, `export default apiClient`,
 * `import apiClient from '@/lib/axios.config'` at the call site — is proven
 * rather than pattern-matched on the receiver's spelling.
 *
 * Deliberately conservative: an unproven receiver returns `false`, which keeps
 * today's behavior for it. The alternative — trusting any identifier with an
 * HTTP-verb method — would classify every Express `router.get('/x', handler)`
 * provider as a consumer of itself.
 */
/**
 * Whether `name`, as a receiver in `fileKey`, IS the axios module — as opposed
 * to an instance built from it, which is {@link isHttpClientRef}'s question.
 *
 * Two ways to be it. The bare spelling `axios` predates the widened query — it
 * is what the original `(#eq? @obj "axios")` pattern matched — so it stays
 * trusted by default, and a file with no facts keeps exactly that behavior; it
 * is withdrawn only where the file itself binds that name to something else.
 * The other way is a declared import or `require` of `'axios'` under any local
 * name, which is proof rather than convention and covers the aliased form the
 * spelling rule cannot see.
 */
export function isAxiosNamespace(fileKey: string, name: string, facts: JsRepoFacts): boolean {
  const file = facts.byFile.get(fileKey);
  if (file === undefined) return name === 'axios';
  if (file.constants.imports.get(name)?.module === 'axios') return true;
  return name === 'axios' && !file.axiosShadowed;
}

export function isHttpClientRef(fileKey: string, name: string, facts: JsRepoFacts): boolean {
  let currentKey = fileKey;
  let currentName = name;

  for (let hop = 0; hop < MAX_REEXPORT_HOPS; hop++) {
    const file = facts.byFile.get(currentKey);
    if (!file) return false;

    if (file.clients.has(currentName)) return true;

    // Local alias: `const client = configuredClient`.
    const expr = file.constants.exprs.get(currentName);
    if (expr && expr.length === 1 && expr[0].kind === 'ref') {
      currentName = expr[0].name;
      continue;
    }

    const binding = file.constants.imports.get(currentName);
    if (!binding) return false;
    const targetKey = facts.resolveImport(currentKey, binding.module, facts.keys);
    if (targetKey === null) return false;

    currentKey = targetKey;
    currentName = resolveExportLocal(facts, targetKey, binding.originalName);
  }
  return false;
}
