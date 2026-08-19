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
}

/**
 * Repo-wide facts, with the two projections the shared fold needs precomputed.
 *
 * `constants` and `keys` are derived from `byFile` and are built ONCE by
 * {@link buildJsRepoFacts}, not per lookup: `resolveConstant` takes a
 * `RepoConstants` and internally materializes a key set, so deriving them at
 * each call site would make every resolution O(files) and the whole scan
 * quadratic in a repo's file count.
 */
export interface JsRepoFacts {
  readonly byFile: ReadonlyMap<string, JsModuleFacts>;
  readonly constants: RepoConstants;
  readonly keys: ReadonlySet<string>;
}

/** Build the {@link JsRepoFacts} projections from per-file facts. */
export function buildJsRepoFacts(byFile: ReadonlyMap<string, JsModuleFacts>): JsRepoFacts {
  const constants = new Map<string, ModuleConstants>();
  for (const [key, value] of byFile) constants.set(key, value.constants);
  return { byFile, constants, keys: new Set(byFile.keys()) };
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
 * The JS/TS {@link ImportResolver}.
 *
 * Relative specifiers (`./api-routes`, `../shared/api-routes`) resolve against
 * the importing file's directory and must hit an existing key exactly.
 *
 * Everything else — a bare specifier (`axios`), a tsconfig path alias
 * (`@/api-modules/shared/api-routes`), a workspace package — is matched by
 * UNIQUE PATH SUFFIX, the same strategy the Python binding uses for absolute
 * imports. This deliberately resolves aliases without reading `tsconfig.json`:
 * an alias prefix is arbitrary (`@/`, `~/`, `#app/`, any `paths` key), but the
 * segments AFTER it are a real path tail, and matching that tail against the
 * indexed file set answers the question directly. A tail shared by two or more
 * files is ambiguous and returns `null`. A bare npm package (`axios`) matches
 * no repo file and also returns `null`, which is correct — it is not ours to
 * resolve.
 */
export const resolveJsImport: ImportResolver = (importingFileKey, moduleSpec, repoKeys) => {
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
  const tail = /^[@~#]\//.test(moduleSpec) ? moduleSpec.slice(2) : moduleSpec;
  if (tail === '' || tail.startsWith('.')) return null;

  let hit: string | null = null;
  for (const candidate of candidatesFor(tail)) {
    for (const key of repoKeys) {
      if (key === candidate || key.endsWith(`/${candidate}`)) {
        if (hit !== null && hit !== key) return null; // ambiguous — refuse to guess
        hit = key;
      }
    }
    if (hit !== null) return hit;
  }
  return null;
};

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
export function parseJsConstOperands(node: Parser.SyntaxNode): Operand[] | null {
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
    const l = parseJsConstOperands(left);
    const r = parseJsConstOperands(right);
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
        const parsed = parseJsConstOperands(inner);
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
 * Node budget for the {@link containsAxiosCreate} subtree walk. An initializer
 * is a bounded expression in practice; the cap only stops a pathological one
 * from making extraction super-linear.
 */
const MAX_CLIENT_SCAN_NODES = 400;

/** True when a node is `axios.create(...)`, allowing an aliased axios import. */
function isAxiosCreateCall(
  node: Parser.SyntaxNode,
  imports: ReadonlyMap<string, { module: string; originalName: string }>,
): boolean {
  if (node.type !== 'call_expression') return false;
  const fn = node.childForFieldName('function');
  if (!fn || fn.type !== 'member_expression') return false;
  if (fn.childForFieldName('property')?.text !== 'create') return false;
  const object = fn.childForFieldName('object');
  if (!object || object.type !== 'identifier') return false;
  // `import axios from 'axios'` is the overwhelming convention, but the local
  // name is the importer's choice (`import ax from 'axios'`), so trust the
  // module specifier over the spelling whenever the file declares one.
  return object.text === 'axios' || imports.get(object.text)?.module === 'axios';
}

/**
 * Whether an initializer expression CONTAINS an `axios.create(...)` call
 * anywhere in its subtree.
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
 * the single binding every call site in such an app goes through, so rejecting
 * it rejects the entire repo. Containment is the weakest premise that still
 * carries real evidence: an expression that builds an axios instance in place
 * and binds the result is an HTTP client by construction. It stays far short of
 * trusting a receiver's name, which is the precision cliff that matters here.
 */
function containsAxiosCreate(
  node: Parser.SyntaxNode,
  imports: ReadonlyMap<string, { module: string; originalName: string }>,
): boolean {
  let budget = MAX_CLIENT_SCAN_NODES;
  const stack: Parser.SyntaxNode[] = [unwrapTsExpression(node)];
  while (stack.length > 0 && budget-- > 0) {
    const cur = stack.pop() as Parser.SyntaxNode;
    if (isAxiosCreateCall(cur, imports)) return true;
    // A nested function body is a different scope's work, not this binding's
    // construction — skip it so a callback that happens to build its own
    // client does not vouch for the outer name.
    if (
      cur.type === 'function_declaration' ||
      cur.type === 'function_expression' ||
      cur.type === 'arrow_function' ||
      cur.type === 'method_definition'
    ) {
      continue;
    }
    for (const child of cur.namedChildren) stack.push(child);
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
): void {
  const value = unwrapTsExpression(valueNode);

  if (containsAxiosCreate(value, imports)) {
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
  exports: Map<string, string> | null,
): void {
  for (const declarator of decl.namedChildren) {
    if (declarator.type !== 'variable_declarator') continue;
    const nameNode = declarator.childForFieldName('name');
    const valueNode = declarator.childForFieldName('value');
    if (!nameNode || nameNode.type !== 'identifier' || !valueNode) continue;
    recordBinding(nameNode.text, valueNode, literals, exprs, clients, imports);
    exports?.set(nameNode.text, nameNode.text);
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

  for (const stmt of tree.rootNode.namedChildren) {
    if (stmt.type === 'lexical_declaration' || stmt.type === 'variable_declaration') {
      recordDeclaration(stmt, literals, exprs, clients, imports, null);
      continue;
    }

    if (stmt.type === 'import_statement') {
      const source = stmt.childForFieldName('source');
      const moduleSpec = source ? literalStringOf(source) : null;
      if (moduleSpec === null) continue;
      for (const clause of stmt.namedChildren) {
        if (clause.type === 'import_clause') {
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
      continue;
    }

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
        recordDeclaration(declaration, literals, exprs, clients, imports, exports);
      }
      continue;
    }

    if (value) {
      // `export default routeApiClient` / `export default axios.create(...)`
      if (value.type === 'identifier') {
        exports.set('default', value.text);
      } else {
        recordBinding(DEFAULT_LOCAL, value, literals, exprs, clients, imports);
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

  return { constants: { literals, exprs, imports }, exports, starExports, clients };
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
  const direct = foldConstant(fileKey, ref, facts.constants, resolveJsImport);
  if (direct !== null) return direct;

  const dot = ref.indexOf('.');
  if (dot < 0) return null;
  const base = ref.slice(0, dot);
  const member = ref.slice(dot + 1);

  const binding = facts.byFile.get(fileKey)?.constants.imports.get(base);
  if (!binding) return null;
  const targetKey = resolveJsImport(fileKey, binding.module, facts.keys);
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
  const here = foldConstant(fileKey, `${local}.${member}`, facts.constants, resolveJsImport);
  if (here !== null) return here;

  const binding = file.constants.imports.get(exported);
  if (binding) {
    const targetKey = resolveJsImport(fileKey, binding.module, facts.keys);
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

  for (const spec of file.starExports) {
    const targetKey = resolveJsImport(fileKey, spec, facts.keys);
    if (targetKey === null) continue;
    const viaStar = resolveExportedMember(targetKey, exported, member, facts, depth + 1, seen);
    if (viaStar !== null) return viaStar;
  }

  return null;
}

/** The local binding an exported name refers to in `fileKey` (identity if unaliased). */
function resolveExportLocal(facts: JsRepoFacts, fileKey: string, exported: string): string {
  return facts.byFile.get(fileKey)?.exports.get(exported) ?? exported;
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
): string {
  const n = unwrapTsExpression(node);

  const literal = literalStringOf(n);
  if (literal !== null) return literal;

  // A template nested inside a substitution — `` `${BASE}${`/${id}/unlike`}` ``
  // is a real shape. Recursing keeps its literal segments; emitting it verbatim
  // would collapse the whole inner template to one `{param}` and lose them.
  if (n.type === 'template_string' || n.type === 'binary_expression') {
    const nested = resolveJsPathExpression(fileKey, n, facts);
    if (nested !== null) return nested;
  }

  const dotted = n.type === 'identifier' ? n.text : dottedNameOf(n);
  if (dotted !== null) {
    const resolved = resolveJsMemberPath(fileKey, dotted, facts);
    if (resolved !== null) return resolved;
    return `\${${dotted}}`;
  }

  return `\${${n.text}}`;
}

/** Flatten a left-nested `a + b + c` chain into its terms, or `null` if not all `+`. */
function flattenConcat(node: Parser.SyntaxNode): Parser.SyntaxNode[] | null {
  const n = unwrapTsExpression(node);
  if (n.type !== 'binary_expression') return [n];
  if (n.childForFieldName('operator')?.text !== '+') return null;
  const left = n.childForFieldName('left');
  const right = n.childForFieldName('right');
  if (!left || !right) return null;
  const l = flattenConcat(left);
  const r = flattenConcat(right);
  return l === null || r === null ? null : [...l, ...r];
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
 * A bare reference that resolves to nothing returns `null` (skip), because a
 * lone unresolved name carries no path information at all; a mixed expression
 * with at least one literal segment still does, so it is returned.
 */
export function resolveJsPathExpression(
  fileKey: string,
  node: Parser.SyntaxNode,
  facts: JsRepoFacts,
): string | null {
  const n = unwrapTsExpression(node);

  const literal = literalStringOf(n);
  if (literal !== null) return literal;

  if (n.type === 'identifier' || n.type === 'member_expression') {
    const dotted = n.type === 'identifier' ? n.text : dottedNameOf(n);
    return dotted === null ? null : resolveJsMemberPath(fileKey, dotted, facts);
  }

  if (n.type === 'template_string') {
    let out = '';
    for (const child of n.namedChildren) {
      if (child.type === 'string_fragment') {
        out += child.text;
      } else if (child.type === 'template_substitution') {
        const inner = child.namedChild(0);
        out += inner === null ? '${}' : foldTermOrPlaceholder(fileKey, inner, facts);
      }
    }
    return out;
  }

  if (n.type === 'binary_expression') {
    const terms = flattenConcat(n);
    if (terms === null) return null;
    return terms.map((term) => foldTermOrPlaceholder(fileKey, term, facts)).join('');
  }

  return null;
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
    const targetKey = resolveJsImport(currentKey, binding.module, facts.keys);
    if (targetKey === null) return false;

    currentKey = targetKey;
    currentName = resolveExportLocal(facts, targetKey, binding.originalName);
  }
  return false;
}
