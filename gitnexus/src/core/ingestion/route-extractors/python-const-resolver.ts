/**
 * Python module-level string-constant resolver (#2391).
 *
 * FastAPI route decorators frequently build their path from a constant rather
 * than a string literal:
 *
 *   # constants.py
 *   API_V1 = "/api/v1"
 *   API_V1_WIDGETS = API_V1 + "/widgets"
 *   API_V1_WIDGETS_GET = API_V1_WIDGETS + "/get"
 *
 *   # routes.py
 *   from .constants import API_V1_WIDGETS_GET
 *   @router.post(API_V1_WIDGETS_GET)          # -> POST /api/v1/widgets/get
 *
 * Without folding these constants the route path is empty and the route is
 * indexed as `POST /` (or dropped entirely on the group-contract side). This
 * module folds such constants to their literal value, following `+`
 * concatenation and import chains across module files.
 *
 * Two halves live here:
 *   • the PURE resolver ({@link resolveConstant} / {@link resolveExpr}) that
 *     folds an already-extracted repo map — no tree-sitter dependency, unit
 *     testable directly; and
 *   • {@link extractPythonModuleConstants}, which walks a parsed tree into the
 *     {@link ModuleConstants} shape the resolver consumes (added in U2).
 *
 * Why a new module and not `core/scope-resolution` (`ScopeResolver`) or the
 * group's `buildLocalStringMap`: the scope-resolution machinery resolves symbol
 * IDENTITIES (call / inheritance edges), not literal string VALUES;
 * `buildLocalStringMap` folds a single same-file string literal into one local
 * variable (no `+`, no imports). Neither can produce a transitive cross-module
 * string value, so this is a genuinely new concern, not a re-implementation.
 *
 * Keying (KTD4): the repo map is keyed by unique POSIX file path, NOT the
 * dot-stripped module basename. `from .constants import X`,
 * `from ..pkg.constants import X`, and `from constants import X` all collapse to
 * the basename `constants` — a ubiquitous filename — so basename keying would
 * resolve one package's routes to another's literal (a confidently WRONG path,
 * worse than an unresolved one). A relative import is therefore resolved against
 * the importing file's package directory (walk up one level per leading dot); an
 * absolute import is matched by unique path suffix and returns `null` (skip
 * floor) when ambiguous.
 */

import { extractStringContent, type SyntaxNode } from '../utils/ast-helpers.js';
import type Parser from 'tree-sitter';

/** Depth ceiling for the import/constant chase. Mirrors `django.ts`'s
 * `MAX_INCLUDE_DEPTH` — a heuristic bound, not a proven one; overrun floors to
 * `null` (skip), never a wrong path. */
const MAX_RESOLVE_DEPTH = 8;

/**
 * One term of a constant's right-hand side. A `+`-concatenation
 * (`A + "/b" + C`) becomes an ordered `Operand[]`; a bare literal is a
 * single-element list.
 */
export type Operand =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'ref'; readonly name: string };

/**
 * A `from <module> import <name> [as <local>]` binding. `module` keeps its
 * leading dots verbatim (`.constants`, `..pkg.constants`, `api.constants`) so
 * the resolver can distinguish relative from absolute imports; `originalName`
 * is the exported name in the target module (pre-alias).
 */
export interface ImportBinding {
  readonly module: string;
  readonly originalName: string;
}

/**
 * String-valued module-level constants of one Python file. `literals` are
 * fully-resolved (`X = "/a"`); `exprs` are unresolved operand lists
 * (`X = A + "/b"`); `imports` maps a local name to the module it was imported
 * from. All string keys are the in-file (local) names.
 */
export interface ModuleConstants {
  readonly literals: Map<string, string>;
  readonly exprs: Map<string, readonly Operand[]>;
  readonly imports: Map<string, ImportBinding>;
}

/** Repo-wide map: unique POSIX file path (e.g. `app/constants.py`) →
 * that file's {@link ModuleConstants}. */
export type RepoConstants = ReadonlyMap<string, ModuleConstants>;

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
 * Resolve an import's module specifier to the unique file key it refers to, or
 * `null` when it cannot be pinned to exactly one file (KTD4).
 *
 * Relative imports (`.constants`, `..pkg.mod`) resolve against the importing
 * file's directory — one level up per leading dot beyond the first — and must
 * hit an existing file key exactly. Absolute imports (`api.constants`) are
 * matched by unique path suffix; a suffix shared by 2+ files is ambiguous and
 * returns `null` rather than an arbitrary winner.
 */
export function resolveImportToFileKey(
  importingFileKey: string,
  moduleSpec: string,
  repoKeys: ReadonlySet<string>,
): string | null {
  const dots = moduleSpec.length - moduleSpec.replace(/^\.+/, '').length;
  const bare = moduleSpec.slice(dots);
  const modPath = bare.replace(/\./g, '/');

  if (dots > 0) {
    // 1 dot = current package (the importing file's dir); each extra dot walks
    // up one more level.
    let base = dirOf(importingFileKey);
    for (let i = 1; i < dots; i++) base = dirOf(base);
    const candidate = normalizePosix(`${base}/${modPath}`) + '.py';
    return repoKeys.has(candidate) ? candidate : null;
  }

  // Absolute: match by unique path suffix. `api.constants` -> `api/constants.py`.
  const suffix = `${modPath}.py`;
  let hit: string | null = null;
  for (const key of repoKeys) {
    if (key === suffix || key.endsWith(`/${suffix}`)) {
      if (hit !== null) return null; // ambiguous — refuse to guess
      hit = key;
    }
  }
  return hit;
}

interface ResolveState {
  readonly repo: RepoConstants;
  readonly repoKeys: ReadonlySet<string>;
  readonly visited: Set<string>;
}

/**
 * Fold an operand list to its concatenated literal, or `null` if any operand is
 * unresolvable (an unknown name, a non-string term, a cycle, or a depth
 * overrun). Shared by {@link resolveConstant} and by an inline `binary_operator`
 * decorator argument (U3 hands its operands straight here).
 */
export function resolveExpr(
  fileKey: string,
  operands: readonly Operand[],
  state: ResolveState,
  depth: number,
): string | null {
  if (depth > MAX_RESOLVE_DEPTH) return null;
  let out = '';
  for (const op of operands) {
    if (op.kind === 'literal') {
      out += op.value;
      continue;
    }
    const resolved = resolveName(fileKey, op.name, state, depth + 1);
    if (resolved === null) return null;
    out += resolved;
  }
  return out;
}

function resolveName(
  fileKey: string,
  name: string,
  state: ResolveState,
  depth: number,
): string | null {
  if (depth > MAX_RESOLVE_DEPTH) return null;
  const guard = `${fileKey}::${name}`;
  if (state.visited.has(guard)) return null; // cycle
  state.visited.add(guard);

  const mc = state.repo.get(fileKey);
  if (!mc) return null;

  const literal = mc.literals.get(name);
  if (literal !== undefined) return literal;

  const expr = mc.exprs.get(name);
  if (expr !== undefined) return resolveExpr(fileKey, expr, state, depth + 1);

  const imp = mc.imports.get(name);
  if (imp !== undefined) {
    const targetKey = resolveImportToFileKey(fileKey, imp.module, state.repoKeys);
    if (targetKey === null) return null;
    return resolveName(targetKey, imp.originalName, state, depth + 1);
  }

  return null;
}

/**
 * Resolve a single named constant referenced in `fileKey` to its literal string
 * value, folding `+` concatenation and following import chains, or `null` when
 * it cannot be fully folded. Each call uses a fresh cycle-guard.
 */
export function resolveConstant(fileKey: string, name: string, repo: RepoConstants): string | null {
  const state: ResolveState = { repo, repoKeys: new Set(repo.keys()), visited: new Set() };
  return resolveName(fileKey, name, state, 0);
}

/**
 * Resolve an inline operand list (an unnamed `+`-expression captured directly at
 * a decorator arg, e.g. `@router.get(API_V1 + "/widgets")`) against `fileKey`.
 */
export function resolveOperands(
  fileKey: string,
  operands: readonly Operand[],
  repo: RepoConstants,
): string | null {
  const state: ResolveState = { repo, repoKeys: new Set(repo.keys()), visited: new Set() };
  return resolveExpr(fileKey, operands, state, 0);
}

// ─── Tree → ModuleConstants extraction (U2) ──────────────────────────────────

/**
 * Parse a right-hand side into an operand list, or `null` when it is not a
 * foldable string expression. Handles a bare string literal, a bare identifier
 * (`X = Y`), and left-associative `+` chains of the two (`A + "/b" + C`).
 * Everything else — numbers, calls, attribute access (`settings.X`), f-strings,
 * `concatenated_string` adjacency, and non-`+` operators — returns `null`, which
 * makes the constant unresolvable (→ skip floor), never a wrong value.
 */
export function parseConstOperands(node: SyntaxNode | null | undefined): Operand[] | null {
  if (!node) return null;
  if (node.type === 'string') {
    const value = extractStringContent(node);
    return value === null ? null : [{ kind: 'literal', value }];
  }
  if (node.type === 'identifier') {
    return [{ kind: 'ref', name: node.text }];
  }
  if (node.type === 'binary_operator') {
    const isPlus = (node.children ?? []).some((c) => c.type === '+');
    if (!isPlus) return null;
    const left = parseConstOperands(node.childForFieldName('left'));
    const right = parseConstOperands(node.childForFieldName('right'));
    if (left === null || right === null) return null;
    return [...left, ...right];
  }
  return null;
}

/**
 * Extract the module-level string constants and `from … import …` bindings of
 * one parsed Python file into the {@link ModuleConstants} shape the resolver
 * consumes. Only top-level (`module`-direct) statements are walked — function-
 * and class-local names never become route path constants and must not leak in.
 *
 * Assignment semantics are last-wins in source order (matches Python): a rebind
 * to a non-string (`X = "/a"; X = build()`) drops `X` to unresolvable rather than
 * keeping the stale literal; `X += "/b"` folds onto the prior representation.
 */
export function extractPythonModuleConstants(tree: Parser.Tree): ModuleConstants {
  const literals = new Map<string, string>();
  const exprs = new Map<string, readonly Operand[]>();
  const imports = new Map<string, ImportBinding>();

  // Apply an assignment result, honoring last-wins: clear any prior binding for
  // `name`, then set the new one (a `null` rep leaves it cleared = unresolvable).
  const setName = (name: string, ops: Operand[] | null): void => {
    literals.delete(name);
    exprs.delete(name);
    if (ops === null) return;
    if (ops.length === 1 && ops[0].kind === 'literal') literals.set(name, ops[0].value);
    else exprs.set(name, ops);
  };

  const currentOps = (name: string): Operand[] | null => {
    const lit = literals.get(name);
    if (lit !== undefined) return [{ kind: 'literal', value: lit }];
    const ex = exprs.get(name);
    return ex !== undefined ? [...ex] : null;
  };

  const handleImport = (node: SyntaxNode): void => {
    const moduleNode = node.childForFieldName('module_name');
    const moduleSpec = moduleNode?.text;
    if (!moduleSpec) return;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child || child.id === moduleNode?.id) continue;
      if (child.type === 'dotted_name') {
        imports.set(child.text, { module: moduleSpec, originalName: child.text });
      } else if (child.type === 'aliased_import') {
        const nameNode = child.childForFieldName('name');
        const aliasNode = child.childForFieldName('alias');
        if (nameNode && aliasNode) {
          imports.set(aliasNode.text, { module: moduleSpec, originalName: nameNode.text });
        }
      }
    }
  };

  for (let i = 0; i < tree.rootNode.namedChildCount; i++) {
    const stmt = tree.rootNode.namedChild(i);
    if (!stmt) continue;
    if (stmt.type === 'import_from_statement') {
      handleImport(stmt);
      continue;
    }
    if (stmt.type !== 'expression_statement') continue;
    const inner = stmt.namedChild(0);
    if (!inner) continue;

    if (inner.type === 'assignment') {
      const left = inner.childForFieldName('left');
      if (left?.type !== 'identifier') continue; // only bare-name module constants
      setName(left.text, parseConstOperands(inner.childForFieldName('right')));
    } else if (inner.type === 'augmented_assignment') {
      const left = inner.childForFieldName('left');
      if (left?.type !== 'identifier') continue;
      const isPlusEq = inner.childForFieldName('operator')?.text === '+=';
      const prior = currentOps(left.text);
      const rhs = parseConstOperands(inner.childForFieldName('right'));
      setName(left.text, isPlusEq && prior && rhs ? [...prior, ...rhs] : null);
    }
  }

  return { literals, exprs, imports };
}
