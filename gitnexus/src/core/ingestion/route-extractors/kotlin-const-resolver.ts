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
 *  3. **File names and directories are free.** `object ApiPaths` may live in
 *     `Constants.kt`, and a file's `package` need not match the directory it
 *     sits in, so a `<package>/<Name>.kt` PATH lookup is a convention and not a
 *     rule. The authority is each file's DECLARED `package`, which
 *     {@link extractKotlinModuleConstants} records and {@link resolveKotlinImport}
 *     requires an exact match on; the path is only a tie-break among files that
 *     already declare the right package.
 *  4. **Member imports are unmarked.** Java spells them `import static a.b.C.F`;
 *     Kotlin writes `import a.b.C.F`, which is byte-identical to a type import
 *     of a class `F` in package `a.b.C`. Nothing in the syntax says which, so
 *     the fold tries both readings (see `resolveImportedName`) instead of
 *     guessing from casing.
 *  5. **Any identifier may be backtick-quoted.** `` package com.example.`api` ``
 *     and `package com.example.api` are the SAME package to the compiler, and a
 *     keyword segment (`` com.example.`fun` ``) can only be spelled the quoted
 *     way. The grammar keeps the backticks in the node text, so every identifier is
 *     read through {@link unquoteKotlinIdentifier} before it becomes a map key
 *     or a lookup name — see that function for what a verbatim comparison cost.
 *
 * THREE PLACES THIS BINDING NO LONGER MIRRORS JAVA, each because the mirrored
 * behavior was wrong rather than merely different, and each open as a Java
 * follow-up rather than fixed here:
 *
 *  * `java-const-resolver.ts` flattens nested types into one file-level
 *    namespace and argues the collision away — "qualified refs carry the class
 *    name, so nesting only matters for same-name fields, which flatten
 *    last-wins". The argument does not hold: the collision is one level BELOW
 *    the qualification, in the initializer, so a fully qualified `A.ROUTE` whose
 *    initializer names a bare sibling `BASE` still resolves through whichever
 *    same-named sibling was walked last. {@link extractKotlinModuleConstants}
 *    keys by Kotlin's own visibility instead.
 *  * Java's import resolution can lean on the `<package>/<Name>.java` layout the
 *    language enforces. Kotlin's cannot, and inferring the package from the path
 *    lets a path-suffix twin outrank the real declaration — so
 *    {@link resolveKotlinImport} reads the declared `package` instead.
 *  * Java's fold entry points take a file and a name, because a Java `static
 *    final` reachable by simple name is reachable that way from anywhere in the
 *    file. A Kotlin COMPANION member is not: it is bound unqualified only inside
 *    its enclosing class body. {@link foldKotlinOperands} therefore also takes
 *    the enclosing type chain of the reference site, which is what lets the
 *    binding answer a bare reference by Kotlin's scoping rather than by "whoever
 *    was walked last" — see {@link qualifyKotlinRefInEnclosingTypes}.
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
 * missing fact; a wrongly folded one is a false edge in the graph. "Exactly one
 * file" is decided from the DECLARED package, not from the path: a path is a
 * repository-layout accident that any decoy directory can imitate, whereas the
 * `package` header is the declaration the compiler itself resolves against.
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

/**
 * What {@link extractKotlinModuleConstants} returns: the agnostic
 * {@link ModuleConstants} plus the one piece of per-file metadata JVM import
 * resolution cannot be honest without — the file's declared `package`.
 *
 * Deliberately a KOTLIN-LOCAL widening rather than a field on the shared type.
 * `ModuleConstants` is consumed by the Java, JS and Python bindings too, and
 * none of them needs this: Python resolves imports from the module path, and
 * Java's `package` is already pinned by the `<package>/<Name>.java` rule the
 * language enforces. Adding a required field there would force three unrelated
 * bindings to fill it in; adding an optional one would put a Kotlin-shaped hole
 * in a type whose whole point is language neutrality.
 *
 * Read the metadata through {@link declaredPackageOf} and
 * {@link unfoldableDeclarationsOf}, never by field access: a
 * {@link RepoConstants} is typed over the agnostic shape, so an entry that some
 * other producer put there carries no package and must be REJECTED as a
 * candidate rather than silently treated as the default package. Missing
 * unfoldable-declaration metadata instead means "none known", preserving the
 * agnostic entry's existing behavior.
 */
export interface KotlinModuleConstants extends ModuleConstants {
  /** The file's declared `package`, or `''` for the default package. */
  readonly packageName: string;
  /** Declaration keys whose initializer cannot be folded. */
  readonly unfoldableDeclarations: ReadonlySet<string>;
}

/**
 * The declared `package` of the file `mc` describes, or null when the entry did
 * not come from {@link extractKotlinModuleConstants} and therefore cannot be
 * matched against an import specifier.
 */
function declaredPackageOf(mc: ModuleConstants | undefined): string | null {
  const declared = (mc as KotlinModuleConstants | undefined)?.packageName;
  return typeof declared === 'string' ? declared : null;
}

const NO_UNFOLDABLE_DECLARATIONS: ReadonlySet<string> = new Set<string>();

/**
 * Kotlin declaration keys known to exist but not fold, or an empty set when
 * `mc` came from another language binding.
 */
export function unfoldableDeclarationsOf(mc: ModuleConstants | undefined): ReadonlySet<string> {
  const declarations = (mc as KotlinModuleConstants | undefined)?.unfoldableDeclarations;
  return declarations instanceof Set ? declarations : NO_UNFOLDABLE_DECLARATIONS;
}

/** Source extensions a Kotlin declaration can live in. */
const KOTLIN_EXTENSIONS = ['.kt', '.kts'] as const;

/**
 * The name a backtick-quoted Kotlin identifier denotes: `` `api` `` → `api`.
 *
 * Quotes are spelling, not part of the name. tree-sitter-kotlin keeps them in
 * node text, so every identifier that becomes a map key or lookup is read
 * through here. Applied per dot-separated segment — a quoted identifier cannot
 * contain `.`. Both the declaration side ({@link declaredPackage}) and the
 * import side ({@link resolveKotlinImport}) are normalized, because either may
 * carry the quotes while the other spells the same name plainly.
 */
export function unquoteKotlinIdentifier(text: string): string {
  return text.length >= 2 && text.startsWith('`') && text.endsWith('`') ? text.slice(1, -1) : text;
}

/** {@link unquoteKotlinIdentifier} applied to every segment of a dotted name. */
function unquoteKotlinDottedName(text: string): string {
  return text.includes('`') ? text.split('.').map(unquoteKotlinIdentifier).join('.') : text;
}

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
 *
 * Both name arms accept a BACKTICK-QUOTED identifier as well as a bare one,
 * because the extractor does: `unquoteKotlinIdentifier` strips the quoting
 * everywhere a name becomes a key, so `const val \`ORDERS\` = "/orders"` is a
 * constant this module resolves. A gate that matched only `\w+` rejected the
 * file outright and the reference floored to skip — a gate narrower than the
 * extractor, which is the one direction the arms above are meant to exclude.
 */
const KOTLIN_NAME = String.raw`(?:\w+|\`[^\`\n]+\`)`;
const CONST_VAL_RE = new RegExp(
  String.raw`\bconst\s+val\s+${KOTLIN_NAME}\s*(?::[^=\n{}()]{0,60})?=`,
);
const OBJECT_DECL_RE = /\bobject\b/;
const VAL_BINDING_RE = new RegExp(String.raw`\bval\s+${KOTLIN_NAME}\s*(?::[^=\n{}()]{0,60})?=`);

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

/**
 * Does the file `mc` describes declare a top-level entity called `name` — an
 * `object`/companion carrier whose members are keyed `name.<MEMBER>`, or a
 * top-level constant keyed `name` outright?
 *
 * A true result is strong enough to select a unique declaring file before path
 * fallbacks: the tested key set is a superset of every local key the fold may
 * subsequently read for that imported name. Two matching files are therefore
 * ambiguous; one is authoritative. A miss falls back to the conservative path
 * heuristics below, whose result is still verified by the actual map lookup.
 */
function declaresTopLevelName(mc: ModuleConstants, name: string): boolean {
  const prefix = `${name}.`;
  for (const map of [mc.literals, mc.exprs]) {
    if (map.has(name)) return true;
    for (const key of map.keys()) if (key.startsWith(prefix)) return true;
  }
  for (const key of unfoldableDeclarationsOf(mc)) {
    if (key === name || key.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Map a fully-qualified import specifier to the unique file key it refers to, or
 * null when it cannot be pinned to exactly one file.
 *
 * A specifier is split at its last dot into the package it names and the
 * declaration inside it (`com.example.app.api` + `ApiPaths`). Resolution then
 * runs in three steps, all of them "unique or nothing":
 *
 *  0. **Declared package** — only files whose `package` header is EXACTLY the
 *     sought package can carry the declaration (compared after
 *     {@link unquoteKotlinIdentifier}, since backtick quoting is spelling and
 *     not identity). This is the authority, and it
 *     is checked first. Kotlin does not require a file's directory to match its
 *     package, so the reverse test — "does this path end with the package?" —
 *     answers a different question, one any decoy directory can satisfy: a file
 *     at `src/x/com/example/api/ApiPaths.kt` declaring `package x.com.example.api`
 *     is not `com.example.api.ApiPaths` and must never be folded as it, and a
 *     path-suffix test also lets a root-level `package data` be impersonated by
 *     `…/com/example/data/`. An entry with no recorded package is rejected, not
 *     assumed to be the default package.
 *  1. **Declared name** — when exactly one file declares the sought name, use
 *     it. When two do, the FQN itself is duplicated in the repository and names
 *     no single declaration, so return null. This is the general form of the
 *     same-FQN check step 2 could only make for files that happen to follow the
 *     file-name convention, and it is what stops a `src/test/…` copy of a
 *     production constant from being folded into a production route.
 *  2. **File named after the declaration** — when declaration metadata found no
 *     owner, try the package-matching file ending
 *     `com/example/app/api/ApiPaths.kt`. Kotlin does not require this (`object
 *     ApiPaths` may live in `Constants.kt`), so it is only a fallback candidate;
 *     the subsequent map lookup must still prove that it carries the value.
 *  3. **Sole file in the package** — when declaration metadata cannot identify
 *     the name, use the unique package-matching candidate. The set passed in
 *     contains files with foldable or explicitly unfoldable declarations, so
 *     unrelated files cannot create ambiguity once step 1 identifies a unique
 *     declarer. With 2+ unidentified candidates it returns null.
 *
 * Steps 2 and 3 can still hand back a file that does not declare the wanted name
 * (its package is right and it is the only candidate, but the name lives
 * elsewhere or nowhere). That remains safe by construction: the fold looks the
 * name up in that file's map, misses, and returns null.
 *
 * A "nearest shared directory" tie-break is deliberately NOT applied when a step
 * has several candidates, for the reason the Java binding records: the JVM
 * resolves duplicate FQNs by classpath order, not directory proximity, so a test
 * fixture copy sitting closer in the tree can outrank the real dependency and
 * yield a silently wrong literal. In a resolver whose whole contract is
 * skip-or-correct, a plausible guess is the one answer that cannot be allowed.
 *
 * This can no longer be typed as the agnostic {@link ModuleConstants} consumer's
 * `ImportResolver`, whose signature carries only file KEYS: deciding a candidate
 * on its declared package needs the map those keys index. Nothing is lost — the
 * core's own fold is not used here either (see the module header), and the
 * alternative is a resolver that must guess from a path.
 */
export function resolveKotlinImport(
  _importingFileKey: string,
  rawModuleSpec: string,
  candidateKeys: ReadonlySet<string>,
  repo: RepoConstants,
): string | null {
  // Normalized here as well as at extraction, so the function answers the same
  // question however a caller spells the specifier.
  const moduleSpec = unquoteKotlinDottedName(rawModuleSpec);
  const lastDot = moduleSpec.lastIndexOf('.');
  const packageName = lastDot < 0 ? '' : moduleSpec.slice(0, lastDot);
  const simpleName = lastDot < 0 ? moduleSpec : moduleSpec.slice(lastDot + 1);

  // Step 0 + step 1 in one pass over the candidates.
  const inPackage: string[] = [];
  let declaring: string | null = null;
  for (const key of candidateKeys) {
    const mc = repo.get(key);
    if (!mc || declaredPackageOf(mc) !== packageName) continue;
    inPackage.push(key);
    if (declaresTopLevelName(mc, simpleName)) {
      if (declaring !== null) return null; // 2+ files declare this FQN
      declaring = key;
    }
  }
  if (inPackage.length === 0) return null;
  if (declaring !== null) return declaring;
  if (inPackage.length === 1) return inPackage[0]; // steps 2 and 3 agree

  // Step 2: the file-name convention, as a tie-break among valid candidates.
  const asPath = moduleSpec.replace(/\./g, '/');
  let named: string | null = null;
  for (const key of inPackage) {
    if (!isFileNamedAfterDeclaration(key, asPath)) continue;
    if (named !== null) return null; // 2+ files spell the convention
    named = key;
  }
  // Step 3 is "the sole candidate", already returned above.
  return named;
}

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
  if (node.type === 'simple_identifier') return unquoteKotlinIdentifier(node.text);
  if (node.type === 'navigation_expression') {
    const target = node.namedChild(0);
    const suffix = node.namedChildren.find((c) => c.type === 'navigation_suffix');
    const field = suffix?.namedChildren.find((c) => c.type === 'simple_identifier');
    if (target && field) {
      const head = flattenNavigation(target);
      return head === null ? null : `${head}.${unquoteKotlinIdentifier(field.text)}`;
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
    return [{ kind: 'ref', name: unquoteKotlinIdentifier(node.text) }];
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
 * One `val` declaration, captured before anything is written to the file's
 * namespace so that the DECLARING SCOPE of every initializer is known regardless
 * of the order the declarations appear in.
 */
interface KotlinConstDeclaration {
  /** The declaration's simple name. */
  readonly name: string;
  /** `<Qualified.DeclaringType>.<NAME>`, or null for a top-level declaration. */
  readonly qualified: string | null;
  /**
   * The qualified-key prefixes in LEXICAL scope for this declaration's
   * initializer, innermost first (`['Outer.Inner', 'Outer']`). Empty at file
   * level.
   */
  readonly scopes: readonly string[];
  /**
   * Is the simple name a FILE-LEVEL binding — one any reference in the file can
   * use unqualified? True only for a top-level `val`. FALSE for a member of a
   * named `object` (which every caller outside that object's body must qualify)
   * and FALSE for a companion member, whose unqualified binding exists only
   * inside its enclosing class body and is reached through
   * {@link qualifyKotlinRefInEnclosingTypes} instead.
   */
  readonly fileLevelName: boolean;
  /**
   * Does an unfoldable initializer here take a same-named IMPORT down with it?
   *
   * True wherever the declaration binds the simple name for at least some of the
   * file — a top-level `val` (everywhere) or a companion member (inside its
   * class). Deliberately wider than {@link fileLevelName}: a companion's shadow
   * is scoped, but this map is not, and over-deleting an import can only cost a
   * route, whereas under-deleting one publishes the imported value at a
   * reference the compiler resolves to the unfoldable member. An `object` member
   * shadows nothing and is false.
   */
  readonly shadowsImport: boolean;
  /** The parsed initializer, or null when it is not a foldable string. */
  readonly operands: readonly Operand[] | null;
}

/**
 * The file's declared `package`, or `''` when it declares none (default
 * package). Shaped exactly like the import walk below: `package_header` holds
 * one `identifier` whose `simple_identifier` children are the dotted segments.
 *
 * Each segment is unquoted (see {@link unquoteKotlinIdentifier}), so a package
 * declared `` com.example.`api` `` is recorded — and therefore matched — as the
 * same package an import spells `com.example.api`.
 */
function declaredPackage(root: Parser.SyntaxNode): string {
  const header = root.children.find((c) => c.type === 'package_header');
  const identifier = header?.children.find((c) => c.type === 'identifier');
  if (!identifier) return '';
  return identifier.namedChildren
    .filter((c) => c.type === 'simple_identifier')
    .map((c) => unquoteKotlinIdentifier(c.text))
    .join('.');
}

/**
 * Extract the declared package, file-level string constants and import bindings
 * of one parsed Kotlin file into the {@link KotlinModuleConstants} shape the
 * resolver consumes.
 *
 * Constants come from the three carriers Kotlin allows a caller to reach without
 * an instance: file top level, `object` members, and `companion object` members.
 * A `val` in a plain class or interface body is per-instance or abstract and is
 * NOT collected — the Kotlin analogue of Java's `static final` requirement. `var`
 * is rejected outright.
 *
 * KEYS FOLLOW KOTLIN'S OWN VISIBILITY, not a flattened namespace. Every constant
 * is recorded under `<DeclaringType>.<NAME>`, the spelling a qualified reference
 * uses, with a companion member keyed under its ENCLOSING CLASS (`Holder.NAME`)
 * because that is how Kotlin source refers to it — `Companion` never appears in
 * a reference. The SIMPLE name is recorded only for a TOP-LEVEL `val`, the one
 * carrier whose bare binding really does span the file. A member of a named
 * `object` gets no bare key, because `BASE` alone does not name `A.BASE` from
 * anywhere outside `object A`'s own body. Writing one anyway (as this binding
 * and the Java one both used to) fabricates a binding the language does not
 * have, and a fabricated key outranks the genuine `import com.example.api.Paths.ORDERS`
 * that {@link computeKotlinFold} consults only after literals and expressions.
 *
 * A COMPANION member gets no bare key either: it is bound unqualified inside
 * its enclosing class body and nowhere else. {@link qualifyKotlinRefInEnclosingTypes}
 * rewrites a bare name to `<EnclosingType>.<NAME>` when an enclosing type
 * declares it, so the companion wins inside its own class and loses everywhere
 * else.
 *
 * An initializer that names a SIBLING is resolved the same way, against its own
 * scope chain, innermost first, before the file level: inside
 * `object A { const val BASE = "/right"; const val ROUTE = BASE + "/m" }` the
 * operand `BASE` is rewritten to `A.BASE`. Collecting every declaration before
 * recording any keeps that independent of declaration order.
 *
 * A TOP-LEVEL initializer has an EMPTY scope chain, so its bare operands stay
 * bare and resolve at file level — they must not pick up a companion key.
 *
 * A non-foldable rebind (`X = compute()`) DROPS X to unresolvable rather than
 * leaving a stale literal — and drops a same-named import with it whenever the
 * declaration shadows that import ANYWHERE (top level, or a companion inside its
 * class). The import map has no scopes, so a companion's shadow is applied
 * file-wide: the conservative direction, costing a route rather than publishing
 * the imported value at a reference the compiler binds to the unfoldable member.
 * An `object` member shadows nothing and must leave the import alone.
 */
export function extractKotlinModuleConstants(tree: Parser.Tree): KotlinModuleConstants {
  const literals = new Map<string, string>();
  const exprs = new Map<string, readonly Operand[]>();
  const imports = new Map<string, ImportBinding>();
  const unfoldableDeclarations = new Set<string>();

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
          .map((c) => unquoteKotlinIdentifier(c.text));
        if (segments.length >= 2) {
          const spec = segments.join('.');
          const originalName = segments[segments.length - 1];
          const aliasNode = node.children
            .find((c) => c.type === 'import_alias')
            ?.namedChildren.find((c) => c.type === 'type_identifier');
          const alias = aliasNode ? unquoteKotlinIdentifier(aliasNode.text) : undefined;
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

  // Pass 2a: collect every declaration, writing nothing yet. Which member each
  // unqualified operand means depends on the whole file, so no key can be
  // written — and no operand rewritten — until the last declaration is in.
  const declarations: KotlinConstDeclaration[] = [];
  /** Declaring scope → the simple names it declares, foldable or not. */
  const membersByScope = new Map<string, Set<string>>();

  const collectProperties = (
    body: Parser.SyntaxNode,
    declaringType: string | null,
    scopes: readonly string[],
    fileLevelName: boolean,
    shadowsImport: boolean,
  ): void => {
    for (const member of body.children ?? []) {
      if (member.type !== 'property_declaration') continue;
      if (bindingKind(member) !== 'val') continue;
      const declaration = member.children.find((c) => c.type === 'variable_declaration');
      const nameNode = declaration?.namedChildren.find((c) => c.type === 'simple_identifier');
      if (!nameNode) continue;
      const name = unquoteKotlinIdentifier(nameNode.text);
      if (declaringType !== null) {
        let members = membersByScope.get(declaringType);
        if (!members) membersByScope.set(declaringType, (members = new Set()));
        // Recorded even when the initializer does not fold: a sibling reference
        // to an unfoldable member must resolve to that member and then MISS,
        // not fall through to a same-named constant at file level.
        members.add(name);
      }
      declarations.push({
        name,
        qualified: declaringType === null ? null : `${declaringType}.${name}`,
        scopes,
        fileLevelName,
        shadowsImport,
        operands: parseKotlinConstOperands(initializerOf(member)),
      });
    }
  };

  const bodyOf = (node: Parser.SyntaxNode): Parser.SyntaxNode | undefined =>
    node.children.find((c) => c.type === 'class_body');

  /** The declared name of an `object_declaration` / `class_declaration`. */
  const typeNameOf = (node: Parser.SyntaxNode): string | null => {
    const ident = node.children.find((c) => c.type === 'type_identifier');
    return ident ? unquoteKotlinIdentifier(ident.text) : null;
  };

  /** Append one simple type name to its enclosing qualified type path. */
  const nestedTypeName = (enclosingType: string | null, name: string | null): string | null => {
    if (name === null) return enclosingType;
    return enclosingType === null ? name : `${enclosingType}.${name}`;
  };

  /** Prepend a qualified scope unless it is already the innermost scope. */
  const withScope = (scope: string | null, scopes: readonly string[]): readonly string[] =>
    scope === null || scopes[0] === scope ? scopes : [scope, ...scopes];

  const walkDeclarations = (
    node: Parser.SyntaxNode,
    enclosingType: string | null,
    scopes: readonly string[],
  ): void => {
    for (const child of node.children ?? []) {
      if (child.type === 'object_declaration') {
        const name = typeNameOf(child);
        const body = bodyOf(child);
        if (!body) continue;
        // Carry the full path: a nested object member is `Outer.Inner.NAME`, not
        // `Inner.NAME`. Inside the body a bare name searches that qualified
        // scope first, then each enclosing type.
        const declaredType = nestedTypeName(enclosingType, name);
        const inner = withScope(declaredType, scopes);
        collectProperties(body, declaredType, inner, false, false);
        walkDeclarations(body, declaredType, inner);
        continue;
      }
      if (child.type === 'companion_object') {
        const body = bodyOf(child);
        if (!body) continue;
        // Referenced through the enclosing class (`Holder.NAME`), never through
        // `Companion` — so the qualified alias is keyed on `enclosingType`. The
        // simple name is bound inside that class body only, which is a SCOPE and
        // not a file-level key: it is reached from the reference site by
        // `qualifyKotlinRefInEnclosingTypes`, through this same `Holder.NAME`.
        const inner = withScope(enclosingType, scopes);
        collectProperties(body, enclosingType, inner, false, true);
        walkDeclarations(body, enclosingType, inner);
        continue;
      }
      if (child.type === 'class_declaration') {
        // A class/interface body's own `val`s are per-instance or abstract, so
        // only its nested objects and companion contribute constants.
        const name = typeNameOf(child);
        const body = bodyOf(child);
        const declaredType = nestedTypeName(enclosingType, name);
        if (body) walkDeclarations(body, declaredType, withScope(declaredType, scopes));
        continue;
      }
      walkDeclarations(child, enclosingType, scopes);
    }
  };

  collectProperties(tree.rootNode, null, [], true, true);
  walkDeclarations(tree.rootNode, null, []);

  // Pass 2b: rewrite each initializer's unqualified operands against the scope
  // chain that encloses it, then record. Only a top-level declaration writes a
  // bare key, so nothing here can collide across scopes; a companion's
  // unqualified binding is applied at the reference site instead.
  const qualifyRef = (refName: string, scopes: readonly string[]): string => {
    if (refName.includes('.')) return refName; // already carries its owner
    for (const scope of scopes) {
      if (membersByScope.get(scope)?.has(refName)) return `${scope}.${refName}`;
    }
    return refName; // file level, or unresolvable — the fold decides
  };

  for (const decl of declarations) {
    const keys: string[] = [];
    if (decl.fileLevelName) keys.push(decl.name);
    if (decl.qualified !== null) keys.push(decl.qualified);

    if (decl.operands === null) {
      for (const key of keys) {
        literals.delete(key);
        exprs.delete(key);
        unfoldableDeclarations.add(key);
      }
      if (decl.shadowsImport) imports.delete(decl.name);
      continue;
    }

    const operands = decl.operands.map((op) =>
      op.kind === 'ref' ? { kind: 'ref' as const, name: qualifyRef(op.name, decl.scopes) } : op,
    );
    const literalValue =
      operands.length === 1 && operands[0].kind === 'literal' ? operands[0].value : null;
    for (const key of keys) {
      unfoldableDeclarations.delete(key);
      if (literalValue !== null) {
        literals.set(key, literalValue);
        exprs.delete(key);
      } else {
        exprs.set(key, operands);
        literals.delete(key);
      }
    }
  }

  return {
    literals,
    exprs,
    imports,
    packageName: declaredPackage(tree.rootNode),
    unfoldableDeclarations,
  };
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
 *  - `constantKeys` is the candidate set import ambiguity is measured over:
 *    files with a foldable or explicitly unfoldable declaration. Measuring over
 *    every repo key would let a file that defines nothing create ambiguity, and
 *    it would rebuild the set on every qualified reference.
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
    if (mc.literals.size > 0 || mc.exprs.size > 0 || unfoldableDeclarationsOf(mc).size > 0) {
      constantKeys.add(key);
    }
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
  const direct = resolveKotlinImport(fileKey, imp.module, state.constantKeys, state.repo);
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
  const ownerFile = resolveKotlinImport(fileKey, ownerSpec, state.constantKeys, state.repo);
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
      const targetFile = resolveKotlinImport(fileKey, imp.module, constantKeys, repo);
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
      const targetFile = resolveKotlinImport(fileKey, fqn, constantKeys, repo);
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
 * Rewrite one BARE reference to the enclosing type that binds it, or leave it
 * bare when none does — the reference-site twin of the `qualifyRef` that
 * {@link extractKotlinModuleConstants} applies to sibling initializers.
 *
 * `enclosingTypes` is the chain of qualified type paths the reference sits
 * inside, INNERMOST FIRST (`['Outer.Inner', 'Outer']`). A companion member is
 * keyed `<EnclosingClass>.<NAME>` and is bound unqualified exactly within that
 * class body — including its nested types, which is why the whole chain is
 * walked and not just the innermost link. An `object`'s own members are in scope
 * inside its body under the same `<Owner>.<NAME>` key, so the same walk covers
 * both.
 *
 * Innermost-first, and BEFORE the file-level maps the fold consults next, is
 * Kotlin's own order: a companion member shadows a same-named top-level
 * declaration and a same-named import throughout its class. Outside that class
 * the bare name never means the companion at all, which is precisely what an
 * empty chain expresses.
 */
function qualifyKotlinRefInEnclosingTypes(
  fileKey: string,
  name: string,
  repo: RepoConstants,
  enclosingTypes: readonly string[],
): string {
  if (name.includes('.')) return name; // already carries its owner
  const mc = repo.get(fileKey);
  if (!mc) return name;
  const unfoldableDeclarations = unfoldableDeclarationsOf(mc);
  for (const type of enclosingTypes) {
    const key = `${type}.${name}`;
    if (mc.literals.has(key) || mc.exprs.has(key) || unfoldableDeclarations.has(key)) {
      return key;
    }
  }
  return name;
}

/**
 * Fold an inline operand list (e.g. `ApiPaths.BASE + "/orders"`) against
 * `fileKey`, or null when any piece is unresolvable (skip floor).
 *
 * `enclosingTypes` is the chain of type declarations the REFERENCE sits inside
 * (innermost first), and it is applied to the entry operands only — everything
 * deeper is either already qualified by
 * {@link extractKotlinModuleConstants} against its own declaring scope, or lives
 * in another file where this chain means nothing. Passing it empty answers
 * "what does this name mean at file level", which is the right question for a
 * reference outside any type and the only one a caller without position
 * information can honestly ask.
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
  enclosingTypes: readonly string[] = [],
): string | null {
  // Allocation gate only — the rule itself lives in the dotted-name early
  // return of qualifyKotlinRefInEnclosingTypes, which this must not restate.
  const needsQualify =
    enclosingTypes.length > 0 && operands.some((op) => op.kind === 'ref' && !op.name.includes('.'));
  const scoped = needsQualify
    ? operands.map((op) =>
        op.kind === 'ref'
          ? {
              kind: 'ref' as const,
              name: qualifyKotlinRefInEnclosingTypes(fileKey, op.name, repo, enclosingTypes),
            }
          : op,
      )
    : operands;
  return foldOperands(fileKey, scoped, newFoldState(repo), 0);
}
