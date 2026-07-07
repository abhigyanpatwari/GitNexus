/**
 * Language-agnostic string-constant folding for route-path resolution (#2391).
 *
 * Route decorators/annotations frequently build their path from a constant rather
 * than a string literal — `@router.post(API_V1_WIDGETS_GET)` (Python),
 * `@GetMapping(PathConstants.WIDGETS)` (Spring), and the Kotlin/C# equivalents are
 * the same shape. This module folds such a constant — or an inline
 * `+`-concatenation — to its literal value, following `+` operands and import
 * chains across a repo-wide, file-keyed constant map.
 *
 * The FOLD is language-neutral: it walks {@link Operand} lists and
 * {@link ModuleConstants} that ANY language's extractor can produce, and defers
 * the one language-specific decision — mapping an import specifier to the file it
 * refers to — to a caller-supplied {@link ImportResolver}. A language binding
 * (e.g. `python-const-resolver.ts`) provides that resolver plus a tree →
 * {@link ModuleConstants} extractor and, if wanted, thin pre-bound wrappers.
 *
 * This mirrors how `route-path.ts` (URL normalization) and `spring-shared.ts`
 * (annotation primitives) are shared across the ingestion and group layers and
 * across languages: the reusable core lives in one place; per-language semantics
 * plug in. It deliberately does NOT reuse `ScopeResolver` (which resolves symbol
 * IDENTITIES, not literal string VALUES) or the `--pdg` `REACHING_DEF` layer
 * (intra-procedural, function-local, def→use reachability — not module-level
 * cross-file value folding).
 */

/** Depth ceiling for the import/constant chase. A heuristic bound, not a proven
 * one; overrun floors to `null` (skip), never a wrong value. */
const MAX_RESOLVE_DEPTH = 8;

/** Max length of a folded path. Real route paths are well under this; a fold that
 * exceeds it is a pathological self-multiplying concat (`X = A + A; A = B + B; …`)
 * whose true value is genuinely huge — building it risks a `RangeError`/heap OOM,
 * so we floor to `null` (skip) instead (#2393). The depth cap bounds recursion but
 * NOT output size, which grows multiplicatively; this bounds the output. */
const MAX_FOLD_LENGTH = 8192;

/**
 * One term of a constant's right-hand side. A `+`-concatenation
 * (`A + "/b" + C`) becomes an ordered `Operand[]`; a bare literal is a
 * single-element list.
 */
export type Operand =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'ref'; readonly name: string };

/**
 * A `from <module> import <name> [as <local>]` (or the language's equivalent)
 * binding. `module` is the import specifier as written (e.g. `.constants`,
 * `..pkg.constants`, `api.constants`) so the {@link ImportResolver} can apply
 * language-specific rules; `originalName` is the exported name in the target
 * module (pre-alias). The map key is the local (in-file) name.
 */
export interface ImportBinding {
  readonly module: string;
  readonly originalName: string;
}

/**
 * String-valued module-level constants of one source file. `literals` are
 * fully-resolved (`X = "/a"`); `exprs` are unresolved operand lists
 * (`X = A + "/b"`); `imports` maps a local name to the module it was imported
 * from. All string keys are the in-file (local) names.
 */
export interface ModuleConstants {
  readonly literals: Map<string, string>;
  readonly exprs: Map<string, readonly Operand[]>;
  readonly imports: Map<string, ImportBinding>;
}

/** Repo-wide map: unique file key (e.g. `app/constants.py`) → that file's
 * {@link ModuleConstants}. */
export type RepoConstants = ReadonlyMap<string, ModuleConstants>;

/**
 * Resolve an import specifier (as written) from `importingFileKey` to the unique
 * repo file key it refers to, or `null` when it cannot be pinned to exactly one
 * file. This is the sole language-specific dependency of the fold: Python uses
 * leading-dot relative imports + `.py`-suffix rules; a JVM binding would use
 * package/classpath rules. Returning `null` on ambiguity keeps the fold honest —
 * an unresolvable or ambiguous import floors to skip, never a wrong path.
 */
export type ImportResolver = (
  importingFileKey: string,
  moduleSpec: string,
  repoKeys: ReadonlySet<string>,
) => string | null;

interface ResolveState {
  readonly repo: RepoConstants;
  readonly repoKeys: ReadonlySet<string>;
  readonly resolveImport: ImportResolver;
  readonly visited: Set<string>;
  readonly memo: Map<string, string>;
}

/**
 * Fold an operand list to its concatenated literal, or `null` if any operand is
 * unresolvable (an unknown name, a non-string term, a cycle, or a depth overrun).
 */
function foldExpr(
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
    } else {
      const resolved = foldName(fileKey, op.name, state, depth + 1);
      if (resolved === null) return null;
      out += resolved;
    }
    if (out.length > MAX_FOLD_LENGTH) return null; // pathological self-multiplying concat → drop
  }
  return out;
}

function foldName(
  fileKey: string,
  name: string,
  state: ResolveState,
  depth: number,
): string | null {
  if (depth > MAX_RESOLVE_DEPTH) return null;
  const guard = `${fileKey}::${name}`;
  // Memoize successful folds. `visited` (below) is the ACTIVE resolution stack
  // for cycle detection — popped on unwind so `A + A` / diamonds fold instead of
  // false-cycling (#2393) — but popping it alone reintroduces recomputation: a
  // wide shared-descendant DAG re-folds each child once per reference, O(fanout^depth),
  // which can exhaust the heap. The never-popped `memo` caps that at O(nodes): a
  // name resolved on one branch is returned directly on the next. Only SUCCESSES
  // are cached — a `null` may be transient (a name that is a cycle on the current
  // branch can resolve on another), so caching it would be unsound.
  const memoized = state.memo.get(guard);
  if (memoized !== undefined) return memoized;
  if (state.visited.has(guard)) return null; // cycle: `name` is on the active stack
  state.visited.add(guard);
  try {
    const result = computeFold(fileKey, name, state, depth);
    if (result !== null) state.memo.set(guard, result);
    return result;
  } finally {
    state.visited.delete(guard);
  }
}

/** The literal/expr/import resolution for one name. Cycle guard + memo live in
 * {@link foldName}; this is the pure lookup body. */
function computeFold(
  fileKey: string,
  name: string,
  state: ResolveState,
  depth: number,
): string | null {
  const mc = state.repo.get(fileKey);
  if (!mc) return null;

  const literal = mc.literals.get(name);
  if (literal !== undefined) return literal;

  const expr = mc.exprs.get(name);
  if (expr !== undefined) return foldExpr(fileKey, expr, state, depth + 1);

  const imp = mc.imports.get(name);
  if (imp !== undefined) {
    const targetKey = state.resolveImport(fileKey, imp.module, state.repoKeys);
    if (targetKey === null) return null;
    return foldName(targetKey, imp.originalName, state, depth + 1);
  }

  return null;
}

function newState(repo: RepoConstants, resolveImport: ImportResolver): ResolveState {
  return {
    repo,
    repoKeys: new Set(repo.keys()),
    resolveImport,
    visited: new Set(),
    memo: new Map(),
  };
}

/**
 * Resolve a single named constant referenced in `fileKey` to its literal string
 * value, folding `+` concatenation and following import chains via
 * `resolveImport`, or `null` when it cannot be fully folded.
 */
export function resolveConstant(
  fileKey: string,
  name: string,
  repo: RepoConstants,
  resolveImport: ImportResolver,
): string | null {
  return foldName(fileKey, name, newState(repo, resolveImport), 0);
}

/**
 * Resolve an inline operand list (an unnamed `+`-expression captured directly at
 * a decorator/annotation argument, e.g. `@router.get(API_V1 + "/widgets")`)
 * against `fileKey`.
 */
export function resolveOperands(
  fileKey: string,
  operands: readonly Operand[],
  repo: RepoConstants,
  resolveImport: ImportResolver,
): string | null {
  return foldExpr(fileKey, operands, newState(repo, resolveImport), 0);
}
