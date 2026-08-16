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
 *   @WinPostMapping(ApiPathConstants.DIAGNOSIS_SAVE_V1)      // qualified
 *   @WinPostMapping(com.winning.opt.X.ApiPathConstants.Y)    // FQN-qualified
 *   @WinPostMapping(DIAGNOSIS_SAVE_V1)                       // static-imported
 *   @WinPostMapping(API_CIS_V1 + "summary/save")             // inline concat
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
import {
  resolveConstant as foldConstant,
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
 * The Java {@link ImportResolver}: map a fully-qualified import specifier to
 * the unique file key it refers to, or null when it cannot be pinned to
 * exactly one file.
 *
 * `com.winning.opt.X.ApiPathConstants` → the file key ending in
 * `com/winning/opt/X/ApiPathConstants.java`. Because the repo map is
 * file-path-keyed and Maven multi-module trees repeat package roots across
 * modules (`winning-opt-a/.../api/constants/ApiPathConstants.java` and
 * `winning-opt-b/.../api/constants/ApiPathConstants.java`), suffix matching
 * must stay UNIQUE-suffix: an import whose class name matches N files in N
 * different modules cannot be pinned by package alone — unless exactly one of
 * them ALSO matches the full package path. We therefore rank candidates:
 *   1. exact full-suffix match (`<pkg-path>/<Class>.java` as a path suffix)
 *   2. class-name-only suffix (`**&#47;<Class>.java`) when exactly one exists
 * and return null when both attempts are ambiguous.
 */
export const resolveJavaImport: ImportResolver = (importingFileKey, moduleSpec, repoKeys) => {
  // A static import `a.b.C.CONST` names the class as all-but-last segment;
  // a plain import `a.b.C` names the class as last segment. Both resolve to
  // a file ending `a/b/C.java`; treating the whole spec as a path and
  // trimming the last segment when the direct hit fails covers both shapes.
  const asPath = moduleSpec.replace(/\./g, '/');
  const classFile = `${asPath}.java`;

  // 1. Exact package-path suffix match.
  let hit: string | null = null;
  let ambiguity = false;
  for (const key of repoKeys) {
    if (key === classFile || key.endsWith(`/${classFile}`)) {
      if (hit !== null) {
        ambiguity = true;
        break;
      }
      hit = key;
    }
  }
  if (!ambiguity) return hit;

  // Ambiguous full-path match (same package+class in 2+ modules is legal in
  // separated-source monorepos but pathological for route constants). Try
  // disambiguating by proximity to the importing file: prefer the candidate
  // sharing the longest leading directory prefix with the importer. This
  // mirrors how Maven/Gradle resolve classpath collisions in practice (nearest
  // module wins) without ever guessing across unrelated trees.
  const candidates: string[] = [];
  for (const key of repoKeys) {
    if (key === classFile || key.endsWith(`/${classFile}`)) candidates.push(key);
  }
  if (candidates.length > 1) {
    const importerDirs = importingFileKey.split('/').slice(0, -1);
    let best: string | null = null;
    let bestDepth = -1;
    let tie = false;
    for (const c of candidates) {
      const cDirs = c.split('/');
      let d = 0;
      while (d < importerDirs.length && d < cDirs.length && importerDirs[d] === cDirs[d]) d++;
      if (d > bestDepth) {
        bestDepth = d;
        best = c;
        tie = false;
      } else if (d === bestDepth) {
        tie = true;
      }
    }
    if (best !== null && !tie) return best;
  }
  return null;
};

/** Is `node` a Java string literal (`"..."`) with its unquoted value? */
function stringLiteralValue(node: Parser.SyntaxNode): string | null {
  if (node.type !== 'string_literal') return null;
  const parts = node.children.filter((c) => c.type === 'string_fragment');
  if (parts.length === 0) {
    // Empty literal `""` has no string_fragment child.
    return '';
  }
  return parts.map((c) => c.text).join('');
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
  // `CONSTS.FIELD` — field_access in tree-sitter-java for expressions.
  if (node.type === 'field_access') {
    const object = node.childForFieldName('object');
    const field = node.childForFieldName('field');
    if (object && field && object.type === 'identifier') {
      return [{ kind: 'ref', name: `${object.text}.${field.text}` }];
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

  // Pass 1: imports (both shapes).
  const walkImports = (node: Parser.SyntaxNode): void => {
    if (node.type === 'import_declaration') {
      // import a.b.C;  |  import static a.b.C;  |  import static a.b.C.F;
      const isStatic = node.children.some((c) => c.type === 'static' && c.text === 'static');
      const scoped = node.children.find((c) => c.type === 'scoped_identifier');
      if (scoped) {
        const text = scoped.text;
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
      const typeText = typeNode.text.replace(/^com\.java\.lang\./, '');
      if (typeText !== 'String' && typeText !== 'java.lang.String') continue;

      const declarators = member.children.filter((c) => c.type === 'variable_declarator');
      for (const decl of declarators) {
        const nameNode = decl.childForFieldName('name');
        const valueNode = decl.childForFieldName('value');
        if (!nameNode) continue;
        const operands = parseJavaConstOperands(valueNode);
        if (operands === null) continue;
        const name = nameNode.text;
        if (operands.length === 1 && operands[0].kind === 'literal') {
          literals.set(name, (operands[0] as { value: string }).value);
        } else {
          exprs.set(name, operands);
        }
        // Qualified alias: `CONSTS.X` refs (folded refs carry the class name).
        if (declaringClass) {
          const qname = `${declaringClass}.${name}`;
          if (operands.length === 1 && operands[0].kind === 'literal') {
            literals.set(qname, (operands[0] as { value: string }).value);
          } else {
            exprs.set(qname, operands);
          }
        }
      }
    }
  };

  const walkTypes = (node: Parser.SyntaxNode, insideInterface: boolean): void => {
    for (const child of node.children ?? []) {
      const isClass = child.type === 'class_declaration';
      const isInterface = child.type === 'interface_declaration';
      if (isClass || isInterface) {
        const nameNode = child.childForFieldName('name');
        const className = nameNode?.text ?? null;
        const body = child.children.find(
          (c) => c.type === 'class_body' || c.type === 'interface_body',
        );
        if (body && className)
          collectFieldConstants(body, isInterface || insideInterface, className);
        if (body) walkTypes(body, isInterface || insideInterface);
      } else if (child.type === 'enum_declaration' || child.type === 'record_declaration') {
        walkTypes(child, insideInterface);
      } else {
        walkTypes(child, insideInterface);
      }
    }
  };
  walkTypes(tree.rootNode, false);

  return { literals, exprs, imports: imports as Map<string, ImportBinding> };
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
): string | null {
  // Qualified ref (`ApiPathConstants.FIELD`): the fold layer keys imports and
  // constants by their IN-FILE name, so a dotted name never hits directly.
  // Split head.tail: resolve the head through the importing file's class
  // import, then look the tail up in the target file — first as the
  // class-qualified alias `Head.TAIL` (what extractJavaModuleConstants
  // records), then as a bare `TAIL` (same-file nested/interface constant).
  const dot = name.indexOf('.');
  if (dot > 0) {
    const head = name.slice(0, dot);
    const tail = name.slice(dot + 1);
    const importing = repo.get(fileKey);
    const imp = importing?.imports.get(head);
    if (imp) {
      const targetFile = resolveJavaImport(fileKey, imp.module, new Set(repo.keys()));
      if (targetFile !== null) {
        const qualified = resolveJavaConstant(targetFile, `${head}.${tail}`, repo);
        if (qualified !== null) return qualified;
        const bare = resolveJavaConstant(targetFile, tail, repo);
        if (bare !== null) return bare;
      }
      return null;
    }
    // Un-imported qualified name (FQN form `com.a.b.C.FIELD`): try resolving
    // the longest dotted prefix as a class import target.
    const parts = name.split('.');
    for (let cut = parts.length - 2; cut >= 1; cut--) {
      const fqn = parts.slice(0, cut + 1).join('.');
      const targetFile = resolveJavaImport(fileKey, fqn, new Set(repo.keys()));
      if (targetFile !== null) {
        const field = parts.slice(cut + 1).join('.');
        const declaring = parts[cut];
        const qualified = resolveJavaConstant(targetFile, `${declaring}.${field}`, repo);
        if (qualified !== null) return qualified;
        return resolveJavaConstant(targetFile, field, repo);
      }
    }
  }
  return foldConstant(fileKey, name, repo, resolveJavaImport);
}

/**
 * Fold an inline operand list (e.g. `API_CIS_V1 + "summary/save"`) against
 * `fileKey`. Unlike the Python binding, refs are resolved through
 * {@link resolveJavaConstant} first — the agnostic fold has no notion of
 * Java's `Class.CONST` qualified names (its import indirection only covers
 * bare names), so each `ref` operand is resolved individually and the pieces
 * are concatenated here.
 */
export function foldJavaOperands(
  fileKey: string,
  operands: readonly Operand[],
  repo: RepoConstants,
): string | null {
  let out = '';
  for (const op of operands) {
    if (op.kind === 'literal') {
      out += op.value;
      continue;
    }
    const piece = resolveJavaConstant(fileKey, op.name, repo);
    if (piece === null) return null;
    out += piece;
  }
  return out === '' ? null : out;
}
