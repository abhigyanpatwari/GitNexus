/**
 * Java binding for the language-agnostic constant resolver (#2391 core).
 *
 * Supplies the two Java-specific pieces the shared fold in
 * `constant-resolver.ts` needs — {@link resolveJavaImport} (import-specifier →
 * file, honoring JVM package/classpath rules) and
 * {@link extractJavaModuleConstants} (tree → {@link ModuleConstants}) — plus a
 * pre-bound {@link resolveJavaConstant} wrapper so callers stay
 * language-oblivious. The reusable fold, the cycle guard, and the depth cap
 * all live in the agnostic core.
 *
 * Java constant shape (one per type declaration; nested classes flatten into
 * the same file-level namespace, mirroring how `Outer.CONST` and a top-level
 * `CONST` are indistinguishable at the fold layer):
 *
 *   public class ApiPathConstants {
 *       public static final String DIAGNOSIS_SAVE_V1 = "/api/v1/diagnosis/add";
 *       public static final String API_CIS_SAVE_SUMMARY = API_CIS_V1 + "summary/save";
 *   }
 *
 * Reference shapes at annotation sites this binding resolves:
 *   @PostMapping(ApiPathConstants.DIAGNOSIS_SAVE_V1)      // qualified
 *   @PostMapping(com.winning.opt.X.ApiPathConstants.Y)    // FQN-qualified
 *   @PostMapping(DIAGNOSIS_SAVE_V1)                       // static-imported
 *   @PostMapping(API_CIS_V1 + "summary/save")             // inline concat
 *
 * Which ANNOTATIONS count as routes is a separate question this module has no
 * say in: `spring-shared.ts` holds an exact-name map, so a vendor alias like
 * `@WinPostMapping` yields no route on this base regardless of how its value
 * folds (#2883). Folding and alias recognition compose; neither implies the
 * other.
 *
 * Import shapes consumed:
 *   import com.winning.opt.diagnosis.api.constants.ApiPathConstants;
 *   import static com.winning.opt.diagnosis.api.constants.ApiPathConstants.API_CIS_V1;
 *
 * Keying (KTD4 parity with the Python binding): the repo map is keyed by
 * unique POSIX file path. A Java import `com.a.b.CONSTS` resolves to the file
 * whose path ends with `com/a/b/CONSTS.java`; when 2+ files share that suffix
 * the import is ambiguous and returns null (skip floor), never a wrong path.
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

/**
 * Cheap content gate: can this Java file DEFINE a string constant that a route
 * annotation might reference?
 *
 * Exported so BOTH sides of the pipeline use the same predicate and cannot
 * disagree about which files carry constants — the ingestion provider
 * (`languages/java.ts`, as `moduleConstantHeuristic`) and the group extractor's
 * `prepareRepo` pre-pass (`group/extractors/http-patterns/java.ts`). They used
 * to spell it differently, and the two spellings disagreed on a constant
 * INTERFACE: the group admitted it and published a provider contract at the
 * folded path, while ingestion rejected the file and emitted no Route node for
 * it — an R4 parity break in the losing direction, since ingestion is the side
 * that drives the graph and `api_impact`.
 *
 * Arms:
 *  - a `static` … `String NAME =` declaration, with the modifier run matched as
 *    a span so every legal order works (`static public final String`,
 *    `public final static String`) and so `java.lang.String` — which the
 *    extractor accepts — is admitted too.
 *  - an `interface` declaration carrying a String assignment — interface fields
 *    are implicitly `public static final` (JLS 9.3), so a pure constant
 *    interface has neither keyword and no import. The assignment conjunct keeps
 *    a file whose PROSE merely mentions "interface " from costing a parse.
 */
// `static` … `String NAME =` on one declaration. The modifier run is matched as
// a span rather than as the adjacent pair `static final`, because the extractor
// scans modifiers INDEPENDENTLY (`isStaticFinal`) and Java lets them appear in
// any order — `static public final String`, `public final static String` — and
// because the type may be written out as `java.lang.String`, which the
// extractor also accepts. A gate narrower than the extractor it feeds is the
// same defect class as the ingestion/group divergence this predicate exists to
// prevent, just one layer down.
//
// The span excludes `;{}()` so it cannot jump a statement or block boundary: a
// local `String s = "x"` inside `static void f() { … }` is not matched, because
// reaching it from `static` crosses `(`, `)` and `{`. `final` is not required
// even though the extractor requires it — the gate may be wider than the
// extractor, never narrower.
const STATIC_STRING_CONSTANT_RE = /\bstatic\b[^;{}()]{0,80}\bString\s+\w+\s*=/;
const INTERFACE_DECL_RE = /\binterface\s+\w/;
const STRING_ASSIGNMENT_RE = /\bString\s+\w+\s*=/;

export function isJavaConstantFile(source: string): boolean {
  if (STATIC_STRING_CONSTANT_RE.test(source)) return true;
  // The interface arm is a bare word match, so on its own it admits any file
  // whose PROSE mentions "interface " — and every admitted file costs the group
  // side a full extra parse. Requiring a String assignment as well keeps every
  // shape `extractJavaModuleConstants` accepts in an interface body (bare
  // `String`, `java.lang.String`, no space before `=`, multi-declarator) while
  // dropping the comment-only matches.
  return INTERFACE_DECL_RE.test(source) && STRING_ASSIGNMENT_RE.test(source);
}

/**
 * The Java {@link ImportResolver}: map a fully-qualified import specifier to
 * the unique file key it refers to, or null when it cannot be pinned to
 * exactly one file.
 *
 * `com.winning.opt.X.ApiPathConstants` → the file key ending in
 * `com/winning/opt/X/ApiPathConstants.java`. Because the repo map is
 * file-path-keyed and Maven multi-module trees repeat package roots across
 * modules (`winning-opt-a/.../api/constants/ApiPathConstants.java` and
 * `winning-opt-b/.../api/constants/ApiPathConstants.java`), suffix matching
 * stays UNIQUE-suffix: an import whose full package+class path matches N files
 * in N different modules cannot be pinned, so it returns null — the skip floor
 * this module promises, never a wrong path.
 *
 * A nearest-shared-directory tie-break was tried here and removed on review:
 * javac resolves duplicate FQNs by CLASSPATH ORDER, not directory proximity, so
 * a `src/test` fixture copy or a module that merely sits closer in the tree can
 * outrank the real dependency and yield a silently wrong literal. In a resolver
 * whose whole contract is skip-or-correct, a plausible guess is the one answer
 * that cannot be allowed.
 */
export const resolveJavaImport: ImportResolver = (_importingFileKey, moduleSpec, repoKeys) => {
  // A static import `a.b.C.CONST` names the class as all-but-last segment;
  // a plain import `a.b.C` names the class as last segment. Both resolve to
  // a file ending `a/b/C.java`; treating the whole spec as a path and
  // trimming the last segment when the direct hit fails covers both shapes.
  const asPath = moduleSpec.replace(/\./g, '/');
  const classFile = `${asPath}.java`;

  // Compare in POSIX space: on Windows the repo keys can carry backslash
  // separators, which would otherwise never match a '/'-joined class file
  // (observed as 675 calls with zero hits on a backslash-keyed repo).
  const toPosix = (p: string): string => p.replace(/\\/g, '/');

  // Exact package-path suffix match, unique or nothing.
  let hit: string | null = null;
  for (const key of repoKeys) {
    const posixKey = toPosix(key);
    if (posixKey === classFile || posixKey.endsWith(`/${classFile}`)) {
      if (hit !== null) return null; // 2+ modules carry this FQN — unresolvable
      hit = key;
    }
  }
  return hit;
};

/**
 * Is `node` a Java string literal (`"..."`), and if so what value does the
 * route layer give it?
 *
 * tree-sitter-java splits a `string_literal` AROUND its `escape_sequence`
 * children, so joining `string_fragment`s alone silently DELETES every escape:
 * `"/user/{id:\\d+}"` — the standard Spring path-variable regex constraint —
 * folded to `/user/{id:d+}`, and a pure-escape literal (`"\\t"`) folded to the
 * empty string. Slicing the quotes off the raw text keeps the source spelling,
 * which is precisely what the LITERAL path does
 * ({@link unquoteSpringLiteral}) — so `@GetMapping(ApiPaths.USER_REGEX)` and
 * `@GetMapping("/user/{id:\\d+}")` now emit the same path for the same Java
 * source instead of two spellings the graph cannot reconcile. Same
 * `string_fragment`-join trap as the NestJS one in #3017.
 */
function stringLiteralValue(node: Parser.SyntaxNode): string | null {
  if (node.type !== 'string_literal') return null;
  // A Java text block is also a `string_literal` here, and `unquoteSpringLiteral`
  // has a `"""` arm that would hand back the raw block — leading newline and
  // incidental indentation included, both of which Java strips. Nothing
  // downstream normalizes that, so it would publish a Route at a path like
  // "\n      /api/v1/x\n    ". The old fragment-join returned '' here, which
  // floored to skip; keep that floor rather than trade it for a wrong path.
  if (node.text.startsWith('"""')) return null;
  return unquoteSpringLiteral(node.text);
}

/**
 * Flatten a qualified-name expression (`ApiPaths`, `com.example.ApiPaths`) to
 * its dotted text, or null when any segment is not a plain identifier (calls,
 * `this`, array access, generics — not a static constant shape).
 */
function flattenQualifiedIdentifier(node: Parser.SyntaxNode): string | null {
  if (node.type === 'identifier') return node.text;
  if (node.type === 'field_access') {
    const object = node.childForFieldName('object');
    const field = node.childForFieldName('field');
    if (object && field) {
      const head = flattenQualifiedIdentifier(object);
      return head === null ? null : `${head}.${field.text}`;
    }
  }
  return null;
}

/**
 * Parse a Java constant initializer into an operand list, or null when it is
 * not a foldable string expression. Handles a bare string literal, a bare
 * identifier (`X = Y`), qualified/static-import-free references
 * (`X = CONSTS.Y` — recorded as ONE ref named `CONSTS.Y`), and
 * left-associative `+` chains of the three. Everything else — numbers, calls,
 * ternaries, method refs, `String.format`, enum constants — returns null,
 * which makes the constant unresolvable (→ skip floor), never a wrong value.
 */
export function parseJavaConstOperands(
  node: Parser.SyntaxNode | null | undefined,
  depth = 0,
): Operand[] | null {
  if (!node) return null;
  if (depth > 64) return null;
  if (node.type === 'string_literal') {
    const value = stringLiteralValue(node);
    return value === null ? null : [{ kind: 'literal', value }];
  }
  if (node.type === 'identifier') {
    return [{ kind: 'ref', name: node.text }];
  }
  // `CONSTS.FIELD` — field_access in tree-sitter-java for expressions. The
  // object side may itself be a chain (`com.example.ApiPaths` parses as
  // nested field_access), so flatten recursively: every segment must be a
  // plain identifier/keyword to qualify (a call `f().X`, `this.X`, or an
  // array access object side is not a constant shape → null, skip floor).
  if (node.type === 'field_access') {
    const object = node.childForFieldName('object');
    const field = node.childForFieldName('field');
    if (object && field) {
      const objectName = flattenQualifiedIdentifier(object);
      if (objectName !== null) return [{ kind: 'ref', name: `${objectName}.${field.text}` }];
    }
    return null;
  }
  if (node.type === 'binary_expression') {
    const isPlus = (node.children ?? []).some((c) => c.type === '+');
    if (!isPlus) return null;
    const left = parseJavaConstOperands(node.childForFieldName('left'), depth + 1);
    const right = parseJavaConstOperands(node.childForFieldName('right'), depth + 1);
    if (left === null || right === null) return null;
    return [...left, ...right];
  }
  return null;
}

/**
 * Extract the file-level string constants and import bindings of one parsed
 * Java file into the {@link ModuleConstants} shape the resolver consumes.
 *
 * Constants: every `static final String NAME = …` field of every type
 * declaration in the file (nested classes included — their simple names
 * would collide at the fold layer, but qualified refs carry the class name
 * so nesting only matters for same-name fields, which flatten last-wins).
 * Interface constants (`String NAME = "…"`) are implicitly static final and
 * are collected too.
 *
 * References to OTHER constants via qualified names (`ApiPathConstants.X`)
 * are stored as refs named `ApiPathConstants.X`; at the fold layer such a ref
 * resolves through the import map (`ApiPathConstants` → module) followed by
 * field lookup in the target file's OWN class-name-qualified namespace. To
 * support that, constant names are ALSO recorded under
 * `<DeclaringClass>.<FIELD>` (both spellings share one entry).
 *
 * Last-wins in source order; a non-foldable rebind (`X = compute()`) drops X
 * to unresolvable rather than keeping a stale literal.
 */
export function extractJavaModuleConstants(tree: Parser.Tree): ModuleConstants {
  const literals = new Map<string, string>();
  const exprs = new Map<string, readonly Operand[]>();
  const imports = new Map<string, ImportBinding>();

  // On-demand static imports (`import static a.b.C.*`) — expanded post-map
  // by expandJavaWildcardStaticImports below.
  const wildcardImports: string[] = [];

  // Pass 1: imports (both shapes).
  const walkImports = (node: Parser.SyntaxNode): void => {
    if (node.type === 'import_declaration') {
      // import a.b.C;  |  import static a.b.C;  |  import static a.b.C.F;
      // import static a.b.C.*;  — asterisk is a sibling of scoped_identifier
      // (tree-sitter-java), not the last path segment. Same detection as
      // import-decomposer.ts (`static-wildcard`).
      const isStatic = node.children.some((c) => c.type === 'static' && c.text === 'static');
      const isWildcard = node.children.some((c) => c.type === 'asterisk');
      const scoped =
        node.children.find((c) => c.type === 'scoped_identifier') ??
        node.children.find((c) => c.type === 'identifier');
      if (scoped) {
        const text = scoped.text;
        if (isStatic && isWildcard) {
          // Class FQN only — members are materialized post-map.
          if (text.length > 0 && !wildcardImports.includes(text)) {
            wildcardImports.push(text);
          }
        } else {
          const lastDot = text.lastIndexOf('.');
          const fqn = text.slice(0, lastDot);
          const name = text.slice(lastDot + 1);
          if (isStatic) {
            // import static a.b.C.F → local F from module a.b.C, original F.
            imports.set(name, { module: fqn, originalName: name });
          } else {
            // import a.b.C → module IS the class FQN; originalName is the class
            // simple name. resolveJavaImport maps `a.b.C` → `a/b/C.java`.
            imports.set(name, { module: text, originalName: name });
          }
        }
      }
    }
    for (const child of node.children ?? []) walkImports(child);
  };
  walkImports(tree.rootNode);

  // Pass 2: constants. A field declaration is a constant when it is
  // `static final` (explicit) or inside an interface (implicit).
  const isStaticFinal = (modifiers: Parser.SyntaxNode | null | undefined): boolean => {
    if (!modifiers) return false;
    let sawStatic = false;
    let sawFinal = false;
    for (const m of modifiers.children ?? []) {
      if (m.type === 'static') sawStatic = true;
      if (m.type === 'final') sawFinal = true;
    }
    return sawStatic && sawFinal;
  };

  const collectFieldConstants = (
    classBody: Parser.SyntaxNode,
    insideInterface: boolean,
    declaringClass: string | null,
  ): void => {
    for (const member of classBody.children ?? []) {
      // tree-sitter-java: interface fields are `constant_declaration`, class
      // fields are `field_declaration`. Both carry `variable_declarator`s.
      if (member.type !== 'field_declaration' && member.type !== 'constant_declaration') continue;
      const mods = member.children.find((c) => c.type === 'modifiers');
      if (!insideInterface && !isStaticFinal(mods)) continue;
      // Type must be String (java.lang.String is implicit-imported).
      const typeNode = member.childForFieldName('type');
      if (!typeNode) continue;
      const typeText = typeNode.text;
      if (typeText !== 'String' && typeText !== 'java.lang.String') continue;

      const declarators = member.children.filter((c) => c.type === 'variable_declarator');
      for (const decl of declarators) {
        const nameNode = decl.childForFieldName('name');
        const valueNode = decl.childForFieldName('value');
        if (!nameNode) continue;
        const name = nameNode.text;
        const operands = parseJavaConstOperands(valueNode);
        // Same-name shadowing across nested types (legal Java, unlike
        // same-class redeclaration): a later binding must REPLACE the earlier
        // flattened simple-name entry — including dropping it to unresolvable
        // when the new initializer is not foldable (`X = compute()`) — rather
        // than leave the stale outer literal resolvable. Skip floor, mirroring
        // Python #2391's rebind-drop. Qualified `Class.FIELD` aliases are
        // per-type-keyed but same-named nested types can still collide, so
        // they get the same replace/drop treatment.
        const qname = declaringClass ? `${declaringClass}.${name}` : null;
        if (operands === null) {
          literals.delete(name);
          exprs.delete(name);
          // …and the static IMPORT of the same simple name. A local
          // `static final String` shadows `import static a.b.C.PATH` inside
          // that class (JLS 6.4.1), so the correct answer for a non-foldable
          // rebind is "unresolvable" — leaving the import alive makes the fold
          // fall through it (computeFold: literals → exprs → imports) and
          // return the IMPORTED value, i.e. a wrong path where the skip floor
          // is owed. #2393's Python defect, reproduced for Java.
          //
          // The delete is file-scoped because these maps are (see the header:
          // nested types flatten into one file-level namespace). So a SIBLING
          // top-level class in the same file that legitimately uses the import
          // loses it too and floors to skip, where javac would resolve it.
          // That direction is the acceptable one — a missing route, not a wrong
          // one — and the shape (two top-level classes, one shadowing a static
          // import with a non-foldable initializer) is vanishingly rare next to
          // the wrong-value it prevents.
          imports.delete(name);
          if (qname) {
            literals.delete(qname);
            exprs.delete(qname);
          }
          continue;
        }
        const literalValue =
          operands.length === 1 && operands[0].kind === 'literal'
            ? (operands[0] as { value: string }).value
            : null;
        if (literalValue !== null) {
          literals.set(name, literalValue);
          exprs.delete(name);
        } else {
          exprs.set(name, operands);
          literals.delete(name);
        }
        // Qualified alias: `CONSTS.X` refs (folded refs carry the class name).
        if (qname) {
          if (literalValue !== null) {
            literals.set(qname, literalValue);
            exprs.delete(qname);
          } else {
            exprs.set(qname, operands);
            literals.delete(qname);
          }
        }
      }
    }
  };

  const walkTypes = (node: Parser.SyntaxNode, insideInterface: boolean): void => {
    for (const child of node.children ?? []) {
      const isInterface = child.type === 'interface_declaration';
      // Enums and records are ordinary type declarations for constant
      // purposes — their fields need an explicit `static final` (JLS 8.9/8.10),
      // unlike an interface's implicitly-constant ones. They used to be only
      // RECURSED into, never collected, so a `static final String` declared
      // directly in an enum or record was silently absent from the map.
      const isTypeDecl =
        isInterface ||
        child.type === 'class_declaration' ||
        child.type === 'enum_declaration' ||
        child.type === 'record_declaration';
      if (!isTypeDecl) {
        walkTypes(child, insideInterface);
        continue;
      }
      const className = child.childForFieldName('name')?.text ?? null;
      const body = child.children.find(
        (c) => c.type === 'class_body' || c.type === 'interface_body' || c.type === 'enum_body',
      );
      if (!body) continue;
      // An enum's members hang one level deeper, under `enum_body_declarations`
      // (the `enum_body` itself holds only the enum constants).
      const memberBody = body.children.find((c) => c.type === 'enum_body_declarations') ?? body;
      // Recompute implicit interface semantics at each type boundary: a
      // class nested in an interface is a normal class whose fields need
      // explicit `static final` (JLS 9.5 — only the interface's own fields
      // are implicitly public static final). Propagating the outer
      // `insideInterface` flag in would harvest mutable nested fields as
      // constants and let a same-name nested field shadow a real interface
      // constant with a stale value.
      if (className) collectFieldConstants(memberBody, isInterface, className);
      // Recurse over the WHOLE body, not just `memberBody`: an enum's constants
      // are siblings of `enum_body_declarations`, so narrowing here dropped any
      // type nested inside an enum-constant body whenever the enum also had
      // member declarations. For a class/interface/record the two are the same
      // node; for an enum `body` is a strict superset, and the extra visit to
      // `enum_body_declarations` collects nothing twice (collectFieldConstants
      // is still called on `memberBody` alone).
      walkTypes(body, isInterface);
    }
  };
  walkTypes(tree.rootNode, false);

  return {
    literals,
    exprs,
    imports: imports as Map<string, ImportBinding>,
    wildcardImports,
  };
}

/**
 * Per-fold state. Mirrors the guards the agnostic core carries in `foldName`,
 * which this binding stopped delegating to once it had to resolve qualified
 * operands itself:
 *
 *  - `memo` caches SUCCESSES only and is never popped. Without it a
 *    shared-descendant DAG (`X_k = X_{k+1} + X_{k+1}`) re-folds each child once
 *    per reference — O(2^depth) — and {@link MAX_FOLD_LENGTH} cannot save it,
 *    because a chain whose intermediate values are the empty string never
 *    accumulates any output. Measured before this state existed: one route over
 *    a 31-line constants file took 2.7 s at 26 levels and 11 s at 28, on the
 *    main thread, per file. A `null` may be transient (a name that cycles on one
 *    branch can resolve on another), so caching it would be unsound.
 *  - `visited` is the ACTIVE resolution stack, popped on unwind, so diamonds
 *    fold instead of false-cycling while true cycles still terminate.
 *  - `constantKeys` is the candidate set import ambiguity is measured over:
 *    files that actually DEFINE a constant. Handing `resolveJavaImport` every
 *    repo key made the two subsystems disagree — ingestion's map also holds
 *    import-only files (its gate has an import arm), so a duplicate FQN that
 *    defines nothing was invisible to the group and made ingestion alone floor
 *    to skip. Hoisting it also stops rebuilding the set on every qualified ref.
 */
interface JavaFoldState {
  readonly repo: RepoConstants;
  readonly constantKeys: ReadonlySet<string>;
  readonly visited: Set<string>;
  readonly memo: Map<string, string>;
}

function newFoldState(repo: RepoConstants): JavaFoldState {
  const constantKeys = new Set<string>();
  for (const [key, mc] of repo) {
    if (mc.literals.size > 0 || mc.exprs.size > 0) constantKeys.add(key);
  }
  return { repo, constantKeys, visited: new Set(), memo: new Map() };
}

/**
 * Resolve a single Java constant referenced in `fileKey` to its literal string
 * value, folding `+` concatenation and following import chains via
 * {@link resolveJavaImport}, or null when it cannot be fully folded.
 *
 * `name` may be simple (`DIAGNOSIS_SAVE_V1`, resolved via static import or
 * same-file constant) or qualified (`ApiPathConstants.DIAGNOSIS_SAVE_V1`,
 * resolved via the class import + the target file's qualified alias).
 */
export function resolveJavaConstant(
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
  state: JavaFoldState,
  depth: number,
): string | null {
  if (depth > 32) return null;
  const guard = `${fileKey}::${name}`;
  const memoized = state.memo.get(guard);
  if (memoized !== undefined) return memoized;
  if (state.visited.has(guard)) return null; // cycle: `name` is on the active stack
  state.visited.add(guard);
  try {
    const result = computeJavaFold(fileKey, name, state, depth);
    if (result !== null) state.memo.set(guard, result);
    return result;
  } finally {
    state.visited.delete(guard);
  }
}

function computeJavaFold(
  fileKey: string,
  name: string,
  state: JavaFoldState,
  depth: number,
): string | null {
  const { repo, constantKeys } = state;
  // Qualified ref (`ApiPathConstants.FIELD`): constants and imports are keyed by
  // their IN-FILE name, so a dotted name never hits directly. Split head.tail:
  // resolve the head through the importing file's class import, then look the
  // tail up in the target file — first as the class-qualified alias `Head.TAIL`
  // (what extractJavaModuleConstants records), then as a bare `TAIL` (same-file
  // nested/interface constant).
  const dot = name.indexOf('.');
  if (dot > 0) {
    const head = name.slice(0, dot);
    const tail = name.slice(dot + 1);
    const imp = repo.get(fileKey)?.imports.get(head);
    if (imp) {
      const targetFile = resolveJavaImport(fileKey, imp.module, constantKeys);
      if (targetFile !== null) {
        const qualified = resolveWithState(targetFile, `${head}.${tail}`, state, depth + 1);
        if (qualified !== null) return qualified;
        const bare = resolveWithState(targetFile, tail, state, depth + 1);
        if (bare !== null) return bare;
      }
      return null;
    }
    // Un-imported qualified name (FQN form `com.a.b.C.FIELD`): try resolving
    // the longest dotted prefix as a class import target.
    const parts = name.split('.');
    for (let cut = parts.length - 2; cut >= 1; cut--) {
      const fqn = parts.slice(0, cut + 1).join('.');
      const targetFile = resolveJavaImport(fileKey, fqn, constantKeys);
      if (targetFile !== null) {
        const field = parts.slice(cut + 1).join('.');
        const declaring = parts[cut];
        const qualified = resolveWithState(targetFile, `${declaring}.${field}`, state, depth + 1);
        if (qualified !== null) return qualified;
        return resolveWithState(targetFile, field, state, depth + 1);
      }
    }
    // No import bound the head and no FQN prefix resolved — fall through. A
    // dotted name is ALSO a valid key in this file's own maps:
    // `extractJavaModuleConstants` records every constant under
    // `<DeclaringClass>.<FIELD>` as well as its simple name, so a same-file
    // qualified reference (`ApiPaths.X` inside ApiPaths.java) resolves below.
  }

  // Name lookup: literals, then same-file expressions, then the import chase.
  // Reached for a bare name and for a dotted name that named no import.
  // Expressions are folded HERE rather than handed to the agnostic core because
  // an operand of a Java initializer may itself be a QUALIFIED ref
  // (`X = BConsts.Y + "/tail"`) and the core only knows bare names: it looks
  // `BConsts.Y` up in maps keyed by simple name, misses, and floors the whole
  // chain to null. Recursing through this function gives every operand the same
  // qualified treatment the entry-point name got.
  const mc = repo.get(fileKey);
  if (!mc) return null;
  const literal = mc.literals.get(name);
  if (literal !== undefined) return literal;
  const expr = mc.exprs.get(name);
  if (expr !== undefined) return foldOperands(fileKey, expr, state, depth + 1);
  const imp = mc.imports.get(name);
  if (imp !== undefined) {
    const targetFile = resolveJavaImport(fileKey, imp.module, constantKeys);
    if (targetFile === null) return null;
    return resolveWithState(targetFile, imp.originalName, state, depth + 1);
  }
  return null;
}

/**
 * Concatenate an operand list, resolving each `ref` through the qualified-aware
 * walk so `Class.CONST` works at every position, not just at the entry point.
 *
 * Bounded by {@link MAX_FOLD_LENGTH}: the depth cap bounds RECURSION but not
 * OUTPUT, which grows multiplicatively (`X = A + A; A = B + B; …`), so a
 * pathological chain would build a gigabyte-scale string before any cap fired.
 * Overrun floors to null (#2393).
 */
function foldOperands(
  fileKey: string,
  operands: readonly Operand[],
  state: JavaFoldState,
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
 * Fold an inline operand list (e.g. `API_CIS_V1 + "summary/save"`) against
 * `fileKey`, or null when any piece is unresolvable (skip floor).
 */
export function foldJavaOperands(
  fileKey: string,
  operands: readonly Operand[],
  repo: RepoConstants,
): string | null {
  const out = foldOperands(fileKey, operands, newFoldState(repo), 0);
  return out === '' ? null : out;
}

/**
 * Constant-defining file keys used by Java import resolution.
 *
 * Build once per repo pass. Recomputing this set for every wildcard-importing
 * controller makes expansion quadratic in controller count.
 */
export function buildJavaConstantKeys(repo: RepoConstants): ReadonlySet<string> {
  const repoKeys = new Set<string>();
  for (const [key, target] of repo) {
    if (target.literals.size > 0 || target.exprs.size > 0) repoKeys.add(key);
  }
  return repoKeys;
}

export interface JavaConstantIndex {
  readonly keys: ReadonlySet<string>;
  /** Every resolvable path suffix as a dotted module name; null means ambiguous. */
  readonly byModule: ReadonlyMap<string, string | null>;
}

/**
 * Build all Java import suffixes once, turning repeated wildcard target lookup
 * from O(importers × constant files) into O(path segments + importers).
 */
export function buildJavaConstantIndex(repo: RepoConstants): JavaConstantIndex {
  const keys = buildJavaConstantKeys(repo);
  const byModule = new Map<string, string | null>();
  for (const key of keys) {
    const normalized = key.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!normalized.endsWith('.java')) continue;
    const segments = normalized.slice(0, -'.java'.length).split('/');
    for (let start = 0; start < segments.length; start++) {
      const moduleName = segments.slice(start).join('.');
      const existing = byModule.get(moduleName);
      if (existing === undefined) byModule.set(moduleName, key);
      else if (existing !== key) byModule.set(moduleName, null);
    }
  }
  return { keys, byModule };
}

export function expandJavaWildcardStaticImports(
  mc: ModuleConstants,
  _fileKey: string,
  repo: RepoConstants,
  index: JavaConstantIndex = buildJavaConstantIndex(repo),
): ModuleConstants {
  const wildcards = mc.wildcardImports;
  if (!wildcards || wildcards.length === 0) return mc;
  // Resolve targets against constant-DEFINING files only. Ingestion's harvest
  // also admits import-only files; measuring uniqueness over every key made
  // a duplicate empty FQN floor ingestion to skip while group still folded
  // (#2980 R4).
  for (const fqn of wildcards) {
    const targetKey = index.byModule.get(fqn) ?? null;
    if (targetKey === null) continue;
    const target = repo.get(targetKey);
    if (!target) continue;
    // Bare member names only — `Class.FIELD` aliases stay reachable through
    // the class-name binding below.
    for (const name of target.literals.keys()) {
      if (!name.includes('.') && !mc.imports.has(name)) {
        mc.imports.set(name, { module: fqn, originalName: name });
      }
    }
    for (const name of target.exprs.keys()) {
      if (!name.includes('.') && !mc.imports.has(name)) {
        mc.imports.set(name, { module: fqn, originalName: name });
      }
    }
    // The class's own simple name binds like a plain class import, so
    // qualified refs (`ApiPath.X` under `import static ...ApiPath.*`) fold too.
    const classSimple = fqn.slice(fqn.lastIndexOf('.') + 1);
    if (classSimple && !mc.imports.has(classSimple)) {
      mc.imports.set(classSimple, { module: fqn, originalName: classSimple });
    }
  }
  return mc;
}
