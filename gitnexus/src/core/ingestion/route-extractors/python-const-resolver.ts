/**
 * Python binding for the language-agnostic constant resolver (#2391).
 *
 * Supplies the two Python-specific pieces the shared fold in
 * `constant-resolver.ts` needs — {@link resolvePythonImport} (import-specifier →
 * file, honoring leading-dot relative imports and `.py` module files) and
 * {@link extractPythonModuleConstants} (tree → {@link ModuleConstants}) — plus
 * pre-bound {@link resolveConstant}/{@link resolveOperands} wrappers so Python
 * callers stay language-oblivious. The reusable fold, the cycle guard, and the
 * depth cap all live in the agnostic core; a JVM/other language binding reuses
 * that core with its own `ImportResolver` + extractor.
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
import {
  resolveConstant as foldConstant,
  resolveOperands as foldOperands,
  type ImportResolver,
  type ModuleConstants,
  type Operand,
  type RepoConstants,
} from './constant-resolver.js';

// Re-export the agnostic types so existing Python callers keep a single import
// site (`import { …, type ModuleConstants } from './python-const-resolver.js'`).
export type {
  ImportBinding,
  ModuleConstants,
  Operand,
  RepoConstants,
} from './constant-resolver.js';

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
 * The Python {@link ImportResolver}: map an import specifier to the unique file
 * key it refers to, or `null` when it cannot be pinned to exactly one file (KTD4).
 *
 * Relative imports (`.constants`, `..pkg.mod`) resolve against the importing
 * file's directory — one level up per leading dot beyond the first — and must
 * hit an existing file key exactly. Absolute imports (`api.constants`) are
 * matched by unique path suffix; a suffix shared by 2+ files is ambiguous and
 * returns `null` rather than an arbitrary winner.
 */
export const resolvePythonImport: ImportResolver = (importingFileKey, moduleSpec, repoKeys) => {
  const dots = moduleSpec.length - moduleSpec.replace(/^\.+/, '').length;
  const bare = moduleSpec.slice(dots);
  const modPath = bare.replace(/\./g, '/');

  if (dots > 0) {
    // 1 dot = current package (the importing file's dir); each extra dot walks
    // up one more level. If the walk would climb ABOVE the repo root (more extra
    // dots than the importing file has directory levels), the import escapes the
    // tree → null, rather than clamping to an unrelated root-level `<name>.py`.
    const dir = dirOf(importingFileKey);
    const depth = dir === '' ? 0 : dir.split('/').length;
    const walk = dots - 1;
    if (walk > depth) return null;

    let base = dir;
    for (let i = 0; i < walk; i++) base = dirOf(base);

    // `from . import X` / `from .. import X` (no module after the dots): the
    // module IS the package, whose file is `<base>/__init__.py`, not a sibling
    // `<base>.py`.
    const candidate =
      modPath === ''
        ? base === ''
          ? '__init__.py'
          : `${base}/__init__.py`
        : normalizePosix(`${base}/${modPath}`) + '.py';
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
};

/**
 * Resolve a single named Python constant referenced in `fileKey` to its literal
 * value, or `null`. Python-bound wrapper over the agnostic fold.
 */
export function resolveConstant(fileKey: string, name: string, repo: RepoConstants): string | null {
  return foldConstant(fileKey, name, repo, resolvePythonImport);
}

/**
 * Resolve an inline Python operand list (an unnamed `+`-expression at a decorator
 * argument, e.g. `@router.get(API_V1 + "/widgets")`) against `fileKey`.
 * Python-bound wrapper over the agnostic fold.
 */
export function resolveOperands(
  fileKey: string,
  operands: readonly Operand[],
  repo: RepoConstants,
): string | null {
  return foldOperands(fileKey, operands, repo, resolvePythonImport);
}

/**
 * Parse a Python right-hand side into an operand list, or `null` when it is not a
 * foldable string expression. Handles a bare string literal, a bare identifier
 * (`X = Y`), and left-associative `+` chains of the two (`A + "/b" + C`).
 * Everything else — numbers, calls, attribute access (`settings.X`), f-strings,
 * conditional expressions (`x if c else y`), `concatenated_string` adjacency, and
 * non-`+` operators — returns `null`, which makes the constant unresolvable
 * (→ skip floor), never a wrong value.
 */
export function parseConstOperands(
  node: SyntaxNode | null | undefined,
  depth = 0,
): Operand[] | null {
  if (!node) return null;
  // Defense-in-depth: bound the recursion so an adversarial deep `+`-chain floors
  // to null (skip) rather than risking a stack overflow. 64 is far beyond any real
  // route-path constant chain; tree-sitter caps expression nesting well below the
  // JS stack limit today, so this is a belt-and-suspenders guard, not a reachable
  // crash. Mirrors the fold engine's MAX_RESOLVE_DEPTH.
  if (depth > 64) return null;
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
    const left = parseConstOperands(node.childForFieldName('left'), depth + 1);
    const right = parseConstOperands(node.childForFieldName('right'), depth + 1);
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
 *
 * Assignment RHS references are SNAPSHOTTED at the assignment line (`snapshot`),
 * not resolved lazily against a name's final binding — so `ROUTE = BASE; BASE +=
 * "/v1"` leaves `ROUTE` at BASE's value AT the `ROUTE =` line, never the mutated
 * one. Without this, an aliased-then-rebound constant resolved to a confidently
 * wrong path (#2393).
 */
export function extractPythonModuleConstants(tree: Parser.Tree): ModuleConstants {
  const literals = new Map<string, string>();
  const exprs = new Map<string, readonly Operand[]>();
  const imports = new Map<string, { module: string; originalName: string }>();
  // Monotonic counter for synthetic import-alias keys (see the `+=`-on-import
  // case in the augmented-assignment branch below). Per-file, so keys are unique
  // within this file's ModuleConstants.
  let importAliasSeq = 0;

  // The three maps are ONE logical namespace keyed by local name: a write to any
  // one clears the other two, so last-binding-in-source-order wins (matches
  // Python) and a name never carries a stale binding from a different map (#2391,
  // #2393). Without this, `from .c import X; X = <dynamic>` would keep the stale
  // import and resolve a confidently WRONG path instead of dropping.

  // Apply an assignment result, honoring last-wins: clear any prior binding for
  // `name` (including a shadowed import), then set the new one (a `null` rep
  // leaves it cleared = unresolvable).
  const setName = (name: string, ops: Operand[] | null): void => {
    literals.delete(name);
    exprs.delete(name);
    imports.delete(name);
    if (ops === null) return;
    if (ops.length === 1 && ops[0].kind === 'literal') literals.set(name, ops[0].value);
    else exprs.set(name, ops);
  };

  // Bind an import for `localName`, clearing any prior local literal/expr of the
  // same name (an import shadows an earlier assignment, and vice versa).
  const bindImport = (
    localName: string,
    binding: { module: string; originalName: string },
  ): void => {
    literals.delete(localName);
    exprs.delete(localName);
    imports.set(localName, binding);
  };

  // Freeze a name's CURRENT binding into a stable operand list that is immune to
  // any LATER rebind of `name`: a literal value, a copy of the current expr (whose
  // refs are themselves already frozen, see `snapshot`), or an import preserved
  // under a synthetic `$imp$N` key (`$` can never appear in a Python identifier, so
  // it cannot collide with a real name). Returns null when `name` is not yet bound
  // (a forward reference — left lazy).
  const freeze = (name: string): Operand[] | null => {
    const lit = literals.get(name);
    if (lit !== undefined) return [{ kind: 'literal', value: lit }];
    const ex = exprs.get(name);
    if (ex !== undefined) return [...ex];
    const imp = imports.get(name);
    if (imp !== undefined) {
      const aliasKey = `$imp$${importAliasSeq++}`;
      imports.set(aliasKey, imp);
      return [{ kind: 'ref', name: aliasKey }];
    }
    return null;
  };

  // Snapshot an assignment RHS: replace each ref to an ALREADY-BOUND name with that
  // name's frozen value, so a later rebind of that name does not retroactively
  // change this binding — Python assigns by value at this source line, so
  // `ROUTE = BASE; BASE += "/v1"` must leave ROUTE at BASE's value AT the `ROUTE =`
  // line, never the mutated one (#2393). Unbound refs (forward references) stay
  // lazy. Because every assignment snapshots, stored exprs only ever contain
  // literals, frozen `$imp$N` refs, or lazy forward refs — never a live mutable ref.
  const snapshot = (ops: Operand[] | null): Operand[] | null => {
    if (ops === null) return null;
    const out: Operand[] = [];
    for (const op of ops) {
      if (op.kind === 'literal') {
        out.push(op);
        continue;
      }
      const frozen = freeze(op.name);
      if (frozen === null) out.push(op);
      else out.push(...frozen);
    }
    return out;
  };

  const handleImport = (node: SyntaxNode): void => {
    const moduleNode = node.childForFieldName('module_name');
    const moduleSpec = moduleNode?.text;
    if (!moduleSpec) return;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child || child.id === moduleNode?.id) continue;
      if (child.type === 'dotted_name') {
        bindImport(child.text, { module: moduleSpec, originalName: child.text });
      } else if (child.type === 'aliased_import') {
        const nameNode = child.childForFieldName('name');
        const aliasNode = child.childForFieldName('alias');
        if (nameNode && aliasNode) {
          bindImport(aliasNode.text, { module: moduleSpec, originalName: nameNode.text });
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
      setName(left.text, snapshot(parseConstOperands(inner.childForFieldName('right'))));
    } else if (inner.type === 'augmented_assignment') {
      const left = inner.childForFieldName('left');
      if (left?.type !== 'identifier') continue;
      const name = left.text;
      const isPlusEq = inner.childForFieldName('operator')?.text === '+=';
      // `X += rhs` folds onto X's CURRENT frozen value (`freeze` handles a local
      // literal/expr and an imported base via the `$imp$N` alias). Both sides are
      // snapshotted so a later rebind cannot retroactively change this binding.
      const prior = freeze(name);
      const rhs = snapshot(parseConstOperands(inner.childForFieldName('right')));
      setName(name, isPlusEq && prior && rhs ? [...prior, ...rhs] : null);
    }
  }

  return { literals, exprs, imports };
}
