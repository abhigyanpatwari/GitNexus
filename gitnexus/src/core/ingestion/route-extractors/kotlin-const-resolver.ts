/**
 * Kotlin binding for the language-agnostic constant resolver (#2391 core).
 *
 * Supplies the two Kotlin-specific pieces — {@link resolveKotlinImport} (import
 * specifier → file, honoring JVM package rules) and
 * {@link extractKotlinModuleConstants} (tree → {@link ModuleConstants}) — plus
 * the folding entry points {@link resolveKotlinConstant} and
 * {@link foldKotlinOperands}, so callers stay language-oblivious.
 *
 * WHAT IS ACTUALLY SHARED WITH THE AGNOSTIC CORE. One value —
 * {@link MAX_FOLD_LENGTH} — and five types. The core's own `resolveConstant` /
 * `resolveOperands` are NOT called: the fold state machine below (cycle guard,
 * success memo, depth caps, operand concatenation — roughly 200 of this file's
 * lines) is a local fork, close enough to `java-const-resolver.ts`'s already
 * forked copy that the two read as the same code with the language name
 * swapped.
 *
 * That fork is a consequence, not an oversight. The core keys its maps by
 * SIMPLE name, and a Kotlin operand can be a QUALIFIED reference at any
 * position (`X = ApiPaths.Y + "/tail"`); handed to the core, `ApiPaths.Y` misses
 * every map and floors the whole chain to null — see {@link computeKotlinFold},
 * which resolves operands through the qualified-aware walk for exactly this
 * reason. The import chase is Kotlin-specific too: a member import is spelled
 * identically to a type import, so {@link resolveImportedName} has to try both
 * readings, and the core exposes no hook for that. Java forked first on the same
 * grounds. Teaching the core qualified names, and retiring both copies against
 * it, is the standing follow-up; until then the honest description of this file
 * is "a second fork", not "a binding over a shared fold".
 *
 * Kotlin shares the JVM package/import model with Java, so this binding mirrors
 * `java-const-resolver.ts` in structure, naming and skip-floor discipline. The
 * four places Kotlin genuinely differs are handled explicitly, not translated:
 *
 *  1. **Where a constant can live.** Java has one carrier (`static final` on a
 *     type). Kotlin has three: a top-level `const val`/`val`, a member of an
 *     `object`, and a member of a `companion object` — the last is referenced
 *     through its ENCLOSING class (`Holder.NAME`), not through `Companion`.
 *  2. **No `String` type gate.** Kotlin infers property types, so
 *     `const val ORDERS = "/orders"` carries no type node to check. The
 *     initializer decides: anything {@link parseKotlinConstOperands} cannot fold
 *     to a string (a number, a call, a template) drops the constant.
 *  3. **File names are free.** `object ApiPaths` may live in `Constants.kt`, so
 *     a `<package>/<Name>.kt` lookup is a convention, not a rule — see
 *     {@link resolveKotlinImport}'s second tier.
 *  4. **Member imports are unmarked.** Java spells them `import static a.b.C.F`;
 *     Kotlin writes `import a.b.C.F`, which is byte-identical to a type import
 *     of a class `F` in package `a.b.C`. Nothing in the syntax says which, so
 *     the fold tries both readings (see `resolveImportedName`) instead of
 *     guessing from casing.
 *
 * Constant shapes this binding harvests:
 *
 *   const val TOP_LEVEL = "/api/v1"          // file top level
 *   object ApiPaths {                        // object member
 *       const val BASE = "/api/v1"
 *       val ORDERS = BASE + "/orders"
 *   }
 *   class Holder { companion object { const val H = "/h" } }   // → Holder.H
 *
 * Reference shapes at annotation sites this binding resolves:
 *   @PostMapping(ApiPaths.ORDERS)                      // qualified
 *   @PostMapping(com.example.app.api.ApiPaths.ORDERS)  // FQN-qualified
 *   @PostMapping(ORDERS)                               // single-name import
 *   @PostMapping(ApiPaths.BASE + "/orders")            // inline concat
 *
 * Which ANNOTATIONS count as routes is a separate question this module has no
 * say in — `spring-shared.ts` owns that map. Folding and annotation recognition
 * compose; neither implies the other.
 *
 * Keying (parity with the Java and Python bindings): the repo map is keyed by
 * unique POSIX file path, and an import that cannot be pinned to exactly one
 * file returns null (skip floor), never a wrong path. A missing route is a
 * missing fact; a wrongly folded one is a false edge in the graph.
 *
 * POSIX keys are a PRECONDITION this module cannot check cheaply, so it is
 * enforced at the one boundary that produces them: `http-patterns/kotlin.ts`
 * normalizes separators on both the write side (the `prepareRepo` map keys) and
 * the read side (`scan`'s `fileRel`). It has to, because the orchestrator's file
 * list comes from glob v13, which has no `posix: true` and joins with the
 * platform separator — so on Windows the keys arrive backslashed and every
 * `<pkg>/<Name>.kt` test in {@link resolveKotlinImport} would miss, silently
 * disabling cross-file folding on that platform alone. Normalizing INSIDE this
 * module instead cannot work: the resolver returns the key it matched, and a
 * normalized return value would then miss in a map that was never normalized.
 *
 * WHERE THIS IS WIRED. Java reaches its binding from BOTH layers: the group
 * extractor (`group/extractors/http-patterns/java.ts`) and the ingestion
 * provider (`languages/java.ts`, via `extractModuleConstants` +
 * `foldRoutePathOperands`). Kotlin is wired into the GROUP layer only, because
 * the ingestion fold in `pipeline-phases/parse-impl.ts` runs exclusively over
 * `decoratorRoutes` — and `languages/kotlin.ts` declares no
 * `extractDecoratorRoutes`, since the ingestion Spring extractor (`spring.ts`)
 * is bound to `tree-sitter-java` and its node types. Declaring the constant
 * hooks on the Kotlin provider today would harvest a map on every Kotlin file
 * that nothing consumes. An ingestion-side Kotlin route extractor is the
 * prerequisite; when it lands, this binding is what its provider hooks should
 * point at, and no change here is needed.
 */

import type Parser from 'tree-sitter';
import { unquoteSpringLiteral } from './spring-shared.js';
import {
  MAX_FOLD_LENGTH,
  type ImportBinding,
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

/** Source extensions a Kotlin declaration can live in. */
const KOTLIN_EXTENSIONS = ['.kt', '.kts'] as const;

/**
 * Recursion ceiling for {@link parseKotlinConstOperands}, counted in `+` links.
 *
 * This bounds SYNTAX depth, not resolution: `A + B + C` nests one
 * `additive_expression` per link, so the cap is really "how long a concatenation
 * may one initializer be". Deliberately loose — generated route tables do
 * concatenate a dozen fragments, and overrunning costs a skipped route, so the
 * cap is a guard against pathological input rather than a statement about
 * reasonable code.
 */
const MAX_OPERAND_PARSE_DEPTH = 64;

/**
 * Recursion ceiling for the fold, counted in REFERENCE hops (`A = B`, `B = C`).
 *
 * Larger than the agnostic core's own `MAX_RESOLVE_DEPTH` (8), which is
 * module-private in `constant-resolver.ts` and therefore cannot simply be
 * reused, and equal to the value the Java binding spells inline. It backstops
 * the cycle guard, which terminates loops but not a long acyclic chain; the
 * memo makes reaching it cheap. Both caps floor to null, i.e. to a skipped
 * route.
 */
const MAX_FOLD_DEPTH = 32;

/**
 * Cheap content gate: can this Kotlin file DEFINE a string constant that a route
 * annotation might reference?
 *
 * Exported so every caller uses the same predicate and none can disagree with
 * {@link extractKotlinModuleConstants} about which files carry constants — the
 * defect class the Java binding's shared `isJavaConstantFile` exists to prevent.
 *
 * Arms, both intended to be WIDER than the extractor (a gate may over-admit — it
 * only costs a parse — while rejecting a file the extractor would accept costs a
 * fact):
 *  - `const val NAME [: T] =`. `const` is legal only at a file's top level or in
 *    an `object`/`companion object`, i.e. exactly the carriers the extractor
 *    harvests, so this arm needs no scope check.
 *  - an `object` (or `companion object`) declaration together with a `val NAME =`
 *    binding. A non-`const` `val` is the other half of the extractor's input and
 *    carries no keyword of its own; requiring an `object` nearby keeps a file
 *    whose only `val`s are function locals from costing a parse. It still admits
 *    a top-level `val` in a file that happens to declare an object elsewhere,
 *    which is the harmless direction.
 *
 * KNOWN GAP — the "never rejects what the extractor accepts" property does NOT
 * hold, and claiming it did was wrong. {@link extractKotlinModuleConstants}
 * calls `collectProperties(tree.rootNode, null)`, so it harvests a TOP-LEVEL
 * non-`const` `val`; a file whose only constant has that shape and declares no
 * `object` fails both arms above (`const val` absent, `object` absent) and is
 * never parsed.
 *
 * The direction is safe — the constant is simply missing from the map, so a
 * reference to it floors to skip, never to a wrong path — but the cost is not
 * nil. Measured on both sides of this change: with the declaration in the SAME
 * file as the route it still folds, because `scan` re-extracts that file's tree
 * on demand and bypasses the gate; with the declaration in its OWN file the
 * route is silently dropped. Closing the gap means admitting every file that
 * contains any `val … =`, function locals included — very nearly the whole
 * repository, in a pass whose entire purpose is to avoid parsing it. That trade
 * has not been measured, so the gap is recorded here rather than papered over.
 */
const CONST_VAL_RE = /\bconst\s+val\s+\w+\s*(?::[^=\n{}()]{0,60})?=/;
const OBJECT_DECL_RE = /\bobject\b/;
const VAL_BINDING_RE = /\bval\s+\w+\s*(?::[^=\n{}()]{0,60})?=/;

export function isKotlinConstantFile(source: string): boolean {
  if (CONST_VAL_RE.test(source)) return true;
  return OBJECT_DECL_RE.test(source) && VAL_BINDING_RE.test(source);
}

/** Does `key` name the file `<asPath>.kt` / `<asPath>.kts`? */
function isFileNamedAfterDeclaration(key: string, asPath: string): boolean {
  for (const ext of KOTLIN_EXTENSIONS) {
    const candidate = `${asPath}${ext}`;
    if (key === candidate || key.endsWith(`/${candidate}`)) return true;
  }
  return false;
}

/** Is `key` a Kotlin file sitting DIRECTLY in the directory `<packageDir>`? */
function isInPackageDirectory(key: string, packageDir: string): boolean {
  const slash = key.lastIndexOf('/');
  if (slash < 0) return false;
  const dir = key.slice(0, slash);
  if (dir !== packageDir && !dir.endsWith(`/${packageDir}`)) return false;
  const fileName = key.slice(slash + 1);
  return KOTLIN_EXTENSIONS.some((ext) => fileName.endsWith(ext));
}

/**
 * The Kotlin {@link ImportResolver}: map a fully-qualified import specifier to
 * the unique file key it refers to, or null when it cannot be pinned to exactly
 * one file.
 *
 * Two tiers, tried in order, each "unique or nothing":
 *
 *  1. **File named after the declaration** — `com.example.app.api.ApiPaths` →
 *     the file ending `com/example/app/api/ApiPaths.kt`. This is the JVM
 *     convention Java can rely on outright, and it is what Kotlin projects
 *     overwhelmingly do.
 *  2. **Package directory** — Kotlin does NOT require the file name to match the
 *     declaration (`object ApiPaths` may live in `Constants.kt`) or, strictly,
 *     the directory to match the package. When tier 1 finds nothing, fall back
 *     to the unique Kotlin file sitting directly in `com/example/app/api/`. The
 *     candidate set the fold passes in is the constant-DEFINING files only, so
 *     "unique file in this package" is a far tighter question than it sounds;
 *     when 2+ files in the package define constants, this returns null and the
 *     fold floors to skip.
 *
 * Tier 2 can hand back a file that does not declare the wanted name at all. That
 * is safe by construction: the fold then looks the name up in that file's map,
 * misses, and returns null. It cannot invent a value — the worst case is a
 * skipped route.
 *
 * A "nearest shared directory" tie-break is deliberately NOT applied when a tier
 * has several candidates, for the reason the Java binding records: the JVM
 * resolves duplicate FQNs by classpath order, not directory proximity, so a test
 * fixture copy sitting closer in the tree can outrank the real dependency and
 * yield a silently wrong literal. In a resolver whose whole contract is
 * skip-or-correct, a plausible guess is the one answer that cannot be allowed.
 */
export const resolveKotlinImport: ImportResolver = (_importingFileKey, moduleSpec, repoKeys) => {
  const asPath = moduleSpec.replace(/\./g, '/');

  let hit: string | null = null;
  for (const key of repoKeys) {
    if (isFileNamedAfterDeclaration(key, asPath)) {
      if (hit !== null) return null; // 2+ modules carry this FQN — unresolvable
      hit = key;
    }
  }
  if (hit !== null) return hit;

  const lastSlash = asPath.lastIndexOf('/');
  if (lastSlash <= 0) return null; // no package part to fall back to
  const packageDir = asPath.slice(0, lastSlash);
  for (const key of repoKeys) {
    if (isInPackageDirectory(key, packageDir)) {
      if (hit !== null) return null; // ambiguous package — unresolvable
      hit = key;
    }
  }
  return hit;
};

/**
 * Is `node` a Kotlin string literal, and if so what value does the route layer
 * give it?
 *
 * Two rejections, both floors rather than guesses:
 *  - **String templates.** `"$base/orders"` parses as a `string_literal` whose
 *    children include an interpolation alongside the `string_content` runs.
 *    Joining the content runs would silently DELETE the interpolated part and
 *    publish `/orders` — a path the application does not serve. Any named child
 *    that is not `string_content` means the value is not statically knowable, so
 *    the literal is refused. (The same test makes the function safe against a
 *    grammar that splits escape sequences into their own nodes: it would floor
 *    to skip, never to a de-escaped path.)
 *  - **Multi-line raw strings.** A single-line `"""/api"""` is exact — unlike a
 *    Java text block, a Kotlin raw string performs no escape processing and no
 *    incidental-indentation stripping, so it folds to precisely its content. A
 *    multi-line one carries newlines (and usually a `.trimIndent()` call this
 *    layer cannot fold), so it is refused.
 *
 * Otherwise the quotes are sliced off the RAW TEXT via
 * {@link unquoteSpringLiteral} — the same function the literal path uses — so
 * `@GetMapping(ApiPaths.USER_REGEX)` and `@GetMapping("/user/{id:\\d+}")` emit
 * the same path for the same Kotlin source.
 */
function stringLiteralValue(node: Parser.SyntaxNode): string | null {
  if (node.type !== 'string_literal') return null;
  for (const child of node.namedChildren) {
    if (child.type !== 'string_content') return null;
  }
  const raw = node.text;
  if (raw.startsWith('"""') && raw.includes('\n')) return null;
  return unquoteSpringLiteral(raw);
}

/**
 * Flatten a navigation expression (`ApiPaths`, `com.example.app.ApiPaths`) to
 * its dotted text, or null when any segment is not a plain identifier (calls,
 * `this`, indexing, safe navigation — not a constant shape).
 */
function flattenNavigation(node: Parser.SyntaxNode): string | null {
  if (node.type === 'simple_identifier') return node.text;
  if (node.type === 'navigation_expression') {
    const target = node.namedChild(0);
    const suffix = node.namedChildren.find((c) => c.type === 'navigation_suffix');
    const field = suffix?.namedChildren.find((c) => c.type === 'simple_identifier');
    if (target && field) {
      const head = flattenNavigation(target);
      return head === null ? null : `${head}.${field.text}`;
    }
  }
  return null;
}

/**
 * Parse a Kotlin constant initializer (or an inline annotation argument) into an
 * operand list, or null when it is not a foldable string expression. Handles a
 * bare string literal, a bare identifier (`X = Y`), a qualified reference
 * (`X = ApiPaths.Y` — recorded as ONE ref named `ApiPaths.Y`), and
 * left-associative `+` chains of the three. Everything else — numbers, calls,
 * `when`/`if` expressions, templates, `buildString` — returns null, which makes
 * the constant unresolvable (→ skip floor), never a wrong value.
 *
 * A chain nests: tree-sitter-kotlin parses `A + B + C` as
 * `additive_expression(additive_expression(A, B), C)`, so every node here has
 * exactly two operands and arbitrary-length chains fold by recursion. The same
 * node type also carries `-`, which is not a string operation, so a `+` token
 * must be present.
 *
 * A PARENTHESIZED operand (`(A + B) + "/c"`) is deliberately NOT unwrapped,
 * matching `parseJavaConstOperands`, which has no parenthesis arm either. The
 * shape is vanishingly rare in a route annotation and the cost of omitting it is
 * a skipped route, not a wrong one; adding it to both bindings at once is the
 * only way to keep them in parity, so it is left to a follow-up.
 */
export function parseKotlinConstOperands(
  node: Parser.SyntaxNode | null | undefined,
  depth = 0,
): Operand[] | null {
  if (!node) return null;
  if (depth > MAX_OPERAND_PARSE_DEPTH) return null;
  if (node.type === 'string_literal') {
    const value = stringLiteralValue(node);
    return value === null ? null : [{ kind: 'literal', value }];
  }
  if (node.type === 'simple_identifier') {
    return [{ kind: 'ref', name: node.text }];
  }
  if (node.type === 'navigation_expression') {
    const name = flattenNavigation(node);
    return name === null ? null : [{ kind: 'ref', name }];
  }
  // `additive_expression` covers both `+` and `-` in tree-sitter-kotlin; only a
  // `+` chain concatenates strings.
  if (node.type === 'additive_expression') {
    if (!(node.children ?? []).some((c) => c.type === '+')) return null;
    const operandNodes = node.namedChildren;
    if (operandNodes.length !== 2) return null;
    const left = parseKotlinConstOperands(operandNodes[0], depth + 1);
    const right = parseKotlinConstOperands(operandNodes[1], depth + 1);
    if (left === null || right === null) return null;
    return [...left, ...right];
  }
  return null;
}

/** The `val`/`var` keyword a property declaration binds with, or null. */
function bindingKind(property: Parser.SyntaxNode): string | null {
  return property.children.find((c) => c.type === 'binding_pattern_kind')?.text ?? null;
}

/**
 * The initializer expression of a property declaration, or null when it has
 * none.
 *
 * Reads the `=` that is a DIRECT child of the `property_declaration`, so a
 * custom getter (`val X: String get() = "/g"`, whose `=` lives under `getter`)
 * and a delegate (`val X by lazy { … }`, which has no `=` at all) both yield
 * null. Both are computed at access time and are not constants.
 */
function initializerOf(property: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let equalsIndex = -1;
  for (let i = 0; i < property.childCount; i++) {
    if (property.child(i)?.type === '=') {
      equalsIndex = i;
      break;
    }
  }
  if (equalsIndex < 0) return null;
  for (let i = equalsIndex + 1; i < property.childCount; i++) {
    const child = property.child(i);
    if (child?.isNamed) return child;
  }
  return null;
}

/**
 * Extract the file-level string constants and import bindings of one parsed
 * Kotlin file into the {@link ModuleConstants} shape the resolver consumes.
 *
 * Constants come from the three carriers Kotlin allows a caller to reach without
 * an instance: file top level, `object` members, and `companion object` members.
 * A `val` in a plain class or interface body is per-instance or abstract and is
 * NOT collected — the Kotlin analogue of Java's `static final` requirement. `var`
 * is rejected outright.
 *
 * Every constant is recorded under its simple name AND, when it has a declaring
 * type, under `<DeclaringType>.<NAME>` — the spelling a qualified reference uses.
 * A companion member is keyed under the ENCLOSING CLASS (`Holder.NAME`), because
 * that is how Kotlin source refers to it; `Companion` never appears in a
 * reference. Nested types flatten into one file-level namespace (same as the
 * Java binding), so same-named members of sibling objects collide on the simple
 * name and resolve last-wins; their qualified spellings stay distinct.
 *
 * A non-foldable rebind (`X = compute()`) DROPS X to unresolvable rather than
 * leaving a stale literal — and drops a same-named import with it, since a local
 * declaration shadows an import for unqualified references and the fold would
 * otherwise fall through to the imported value, i.e. a wrong path where the skip
 * floor is owed.
 */
export function extractKotlinModuleConstants(tree: Parser.Tree): ModuleConstants {
  const literals = new Map<string, string>();
  const exprs = new Map<string, readonly Operand[]>();
  const imports = new Map<string, ImportBinding>();

  // Pass 1: imports.
  const walkImports = (node: Parser.SyntaxNode): void => {
    if (node.type === 'import_header') {
      // `import a.b.*` binds no single name — nothing to key the fold on, and
      // guessing which package member a bare reference came from is exactly the
      // wrong answer. Skipped, so such a reference floors to skip.
      const isWildcard = node.children.some((c) => c.type === 'wildcard_import');
      const identifier = node.children.find((c) => c.type === 'identifier');
      if (!isWildcard && identifier) {
        const segments = identifier.namedChildren
          .filter((c) => c.type === 'simple_identifier')
          .map((c) => c.text);
        if (segments.length >= 2) {
          const spec = segments.join('.');
          const originalName = segments[segments.length - 1];
          const alias = node.children
            .find((c) => c.type === 'import_alias')
            ?.namedChildren.find((c) => c.type === 'type_identifier')?.text;
          // `module` is the specifier AS WRITTEN, complete. Kotlin does not mark
          // member imports, so the fold — not the extractor — decides whether the
          // trailing segment is a declaration or one of its members.
          imports.set(alias ?? originalName, { module: spec, originalName });
        }
      }
      return;
    }
    for (const child of node.children ?? []) walkImports(child);
  };
  walkImports(tree.rootNode);

  // Pass 2: constants.
  const record = (name: string, operands: readonly Operand[] | null, qualified: string | null) => {
    if (operands === null) {
      literals.delete(name);
      exprs.delete(name);
      imports.delete(name);
      if (qualified) {
        literals.delete(qualified);
        exprs.delete(qualified);
      }
      return;
    }
    const literalValue =
      operands.length === 1 && operands[0].kind === 'literal'
        ? (operands[0] as { value: string }).value
        : null;
    for (const key of qualified ? [name, qualified] : [name]) {
      if (literalValue !== null) {
        literals.set(key, literalValue);
        exprs.delete(key);
      } else {
        exprs.set(key, operands);
        literals.delete(key);
      }
    }
  };

  const collectProperties = (body: Parser.SyntaxNode, declaringType: string | null): void => {
    for (const member of body.children ?? []) {
      if (member.type !== 'property_declaration') continue;
      if (bindingKind(member) !== 'val') continue;
      const declaration = member.children.find((c) => c.type === 'variable_declaration');
      const nameNode = declaration?.namedChildren.find((c) => c.type === 'simple_identifier');
      if (!nameNode) continue;
      const name = nameNode.text;
      record(
        name,
        parseKotlinConstOperands(initializerOf(member)),
        declaringType ? `${declaringType}.${name}` : null,
      );
    }
  };

  const bodyOf = (node: Parser.SyntaxNode): Parser.SyntaxNode | undefined =>
    node.children.find((c) => c.type === 'class_body');

  const walkDeclarations = (node: Parser.SyntaxNode, enclosingType: string | null): void => {
    for (const child of node.children ?? []) {
      if (child.type === 'object_declaration') {
        const name = child.children.find((c) => c.type === 'type_identifier')?.text ?? null;
        const body = bodyOf(child);
        if (!body) continue;
        collectProperties(body, name);
        walkDeclarations(body, name);
        continue;
      }
      if (child.type === 'companion_object') {
        const body = bodyOf(child);
        if (!body) continue;
        // Referenced through the enclosing class (`Holder.NAME`), never through
        // `Companion` — so the qualified alias is keyed on `enclosingType`.
        collectProperties(body, enclosingType);
        walkDeclarations(body, enclosingType);
        continue;
      }
      if (child.type === 'class_declaration') {
        // A class/interface body's own `val`s are per-instance or abstract, so
        // only its nested objects and companion contribute constants.
        const name = child.children.find((c) => c.type === 'type_identifier')?.text ?? null;
        const body = bodyOf(child);
        if (body) walkDeclarations(body, name);
        continue;
      }
      walkDeclarations(child, enclosingType);
    }
  };

  collectProperties(tree.rootNode, null);
  walkDeclarations(tree.rootNode, null);

  return { literals, exprs, imports };
}

/**
 * Per-fold state. Mirrors {@link resolveJavaConstant}'s, for the same reasons:
 *
 *  - `memo` caches SUCCESSES only and is never popped, so a shared-descendant
 *    DAG (`X_k = X_{k+1} + X_{k+1}`) folds in O(nodes) instead of O(2^depth).
 *    A `null` may be transient — a name that cycles on one branch can resolve on
 *    another — so caching it would be unsound.
 *  - `visited` is the ACTIVE resolution stack, popped on unwind, so diamonds fold
 *    instead of false-cycling while true cycles still terminate.
 *  - `constantKeys` is the candidate set import ambiguity is measured over: files
 *    that actually DEFINE a constant. Measuring over every repo key would let a
 *    file that defines nothing create ambiguity, and it would rebuild the set on
 *    every qualified reference.
 */
interface KotlinFoldState {
  readonly repo: RepoConstants;
  readonly constantKeys: ReadonlySet<string>;
  readonly visited: Set<string>;
  readonly memo: Map<string, string>;
}

function newFoldState(repo: RepoConstants): KotlinFoldState {
  const constantKeys = new Set<string>();
  for (const [key, mc] of repo) {
    if (mc.literals.size > 0 || mc.exprs.size > 0) constantKeys.add(key);
  }
  return { repo, constantKeys, visited: new Set(), memo: new Map() };
}

/**
 * Resolve a single Kotlin constant referenced in `fileKey` to its literal string
 * value, folding `+` concatenation and following import chains via
 * {@link resolveKotlinImport}, or null when it cannot be fully folded.
 *
 * `name` may be simple (`ORDERS`, resolved via a single-name import or a
 * same-file constant) or qualified (`ApiPaths.ORDERS`, resolved via the type
 * import plus the target file's qualified alias).
 */
export function resolveKotlinConstant(
  fileKey: string,
  name: string,
  repo: RepoConstants,
  depth = 0,
): string | null {
  return resolveWithState(fileKey, name, newFoldState(repo), depth);
}

function resolveWithState(
  fileKey: string,
  name: string,
  state: KotlinFoldState,
  depth: number,
): string | null {
  if (depth > MAX_FOLD_DEPTH) return null;
  const guard = `${fileKey}::${name}`;
  const memoized = state.memo.get(guard);
  if (memoized !== undefined) return memoized;
  if (state.visited.has(guard)) return null; // cycle: `name` is on the active stack
  state.visited.add(guard);
  try {
    const result = computeKotlinFold(fileKey, name, state, depth);
    if (result !== null) state.memo.set(guard, result);
    return result;
  } finally {
    state.visited.delete(guard);
  }
}

/**
 * Resolve a name bound by an import, trying both readings of the specifier.
 *
 * Kotlin writes a member import exactly like a type import, so
 * `import com.example.app.api.ApiPaths.ORDERS` is syntactically
 * indistinguishable from a type import of `ORDERS` in package
 * `com.example.app.api.ApiPaths`. Rather than guess from casing — a convention,
 * not a rule, and one that quietly breaks on `object apiPaths` or `const val
 * Orders` — both readings are attempted and the first that actually RESOLVES
 * wins. A reading that resolves to no constant simply falls through.
 */
function resolveImportedName(
  fileKey: string,
  imp: ImportBinding,
  state: KotlinFoldState,
  depth: number,
): string | null {
  // Reading A: the specifier names the declaration itself (a top-level
  // `const val`, or a type whose file we then search).
  const direct = resolveKotlinImport(fileKey, imp.module, state.constantKeys);
  if (direct !== null) {
    const value = resolveWithState(direct, imp.originalName, state, depth);
    if (value !== null) return value;
  }
  // Reading B: the specifier names a MEMBER of the declaration one segment up
  // (`…ApiPaths.ORDERS` → member `ORDERS` of `ApiPaths`).
  const dot = imp.module.lastIndexOf('.');
  if (dot <= 0) return null;
  const ownerSpec = imp.module.slice(0, dot);
  const ownerName = ownerSpec.slice(ownerSpec.lastIndexOf('.') + 1);
  const ownerFile = resolveKotlinImport(fileKey, ownerSpec, state.constantKeys);
  if (ownerFile === null) return null;
  return resolveWithState(ownerFile, `${ownerName}.${imp.originalName}`, state, depth);
}

function computeKotlinFold(
  fileKey: string,
  name: string,
  state: KotlinFoldState,
  depth: number,
): string | null {
  const { repo, constantKeys } = state;
  // Qualified reference (`ApiPaths.ORDERS`): constants and imports are keyed by
  // their IN-FILE name, so a dotted name never hits directly. Split head.tail,
  // resolve the head through the importing file's type import, then look the
  // member up in the target file under its declaring name.
  //
  // Unlike the Java binding there is NO bare-`tail` fallback: in Kotlin
  // `Head.TAIL` means TAIL is a member of the object or companion `Head`, so a
  // top-level `TAIL` in the target file is a different declaration and matching
  // it would fabricate a value.
  const dot = name.indexOf('.');
  if (dot > 0) {
    const head = name.slice(0, dot);
    const tail = name.slice(dot + 1);
    const imp = repo.get(fileKey)?.imports.get(head);
    if (imp) {
      const targetFile = resolveKotlinImport(fileKey, imp.module, constantKeys);
      if (targetFile === null) return null;
      // `originalName` un-aliases `import … .ApiPaths as Paths`, so the lookup
      // uses the declaring type's real name.
      return resolveWithState(targetFile, `${imp.originalName}.${tail}`, state, depth + 1);
    }
    // Un-imported qualified name (FQN form `com.example.app.api.ApiPaths.ORDERS`):
    // try the longest dotted prefix that resolves to a file.
    const parts = name.split('.');
    for (let cut = parts.length - 2; cut >= 1; cut--) {
      const fqn = parts.slice(0, cut + 1).join('.');
      const targetFile = resolveKotlinImport(fileKey, fqn, constantKeys);
      if (targetFile !== null) {
        const declaring = parts[cut];
        const member = parts.slice(cut + 1).join('.');
        return resolveWithState(targetFile, `${declaring}.${member}`, state, depth + 1);
      }
    }
    // No import bound the head and no FQN prefix resolved — fall through. A
    // dotted name is ALSO a valid key in this file's own maps, so a same-file
    // qualified reference (`ApiPaths.ORDERS` inside the file declaring
    // `object ApiPaths`) resolves below.
  }

  // Name lookup: literals, then same-file expressions, then the import chase.
  // Expressions are folded HERE rather than handed to the agnostic core because
  // an operand may itself be a QUALIFIED reference (`X = ApiPaths.Y + "/tail"`)
  // and the core only knows bare names: it would look `ApiPaths.Y` up in maps
  // keyed by simple name, miss, and floor the whole chain to null.
  const mc = repo.get(fileKey);
  if (!mc) return null;
  const literal = mc.literals.get(name);
  if (literal !== undefined) return literal;
  const expr = mc.exprs.get(name);
  if (expr !== undefined) return foldOperands(fileKey, expr, state, depth + 1);
  const imp = mc.imports.get(name);
  if (imp !== undefined) return resolveImportedName(fileKey, imp, state, depth + 1);
  return null;
}

/**
 * Concatenate an operand list, resolving each `ref` through the qualified-aware
 * walk so `ApiPaths.BASE` works at every position, not just at the entry point.
 *
 * Bounded by {@link MAX_FOLD_LENGTH}: the depth cap bounds RECURSION but not
 * OUTPUT, which grows multiplicatively (`X = A + A; A = B + B; …`), so a
 * pathological chain would build a gigabyte-scale string before any cap fired.
 * Overrun floors to null.
 */
function foldOperands(
  fileKey: string,
  operands: readonly Operand[],
  state: KotlinFoldState,
  depth: number,
): string | null {
  let out = '';
  for (const op of operands) {
    if (op.kind === 'literal') {
      out += op.value;
    } else {
      const piece = resolveWithState(fileKey, op.name, state, depth);
      if (piece === null) return null;
      out += piece;
    }
    if (out.length > MAX_FOLD_LENGTH) return null;
  }
  return out;
}

/**
 * Fold an inline operand list (e.g. `ApiPaths.BASE + "/orders"`) against
 * `fileKey`, or null when any piece is unresolvable (skip floor).
 *
 * An empty result is a SUCCESS, not a skip. `const val ROOT = ""` folds to `""`,
 * which `joinPath` then resolves against the class-level prefix exactly as it
 * resolves the literal `@GetMapping("")` — both mean "the prefix itself", the
 * Spring idiom for a collection root. Collapsing it into `null` would make a
 * resolved-empty path indistinguishable from an unresolvable one — the skip
 * floor is reserved for "could not fold", and nothing else in the resolver
 * conflates the two: {@link resolveKotlinConstant} returns `''` for an empty
 * constant, and `resolveOperands` in the shared core returns its fold
 * unfiltered. Matches `foldJavaOperands`, so the two JVM bindings do not
 * diverge on the same input.
 */
export function foldKotlinOperands(
  fileKey: string,
  operands: readonly Operand[],
  repo: RepoConstants,
): string | null {
  return foldOperands(fileKey, operands, newFoldState(repo), 0);
}
