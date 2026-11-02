/**
 * Anonymised source shapes for the input facet (Layer 2, U6, R5, KTD6, design §5.3 rules 1, 2, 7
 * and 8).
 *
 * Rule 1, inline source: a test literal that looks like code, in the language the test names
 * ({@link languageOf}: `SupportedLanguages.X`, a grammar identifier argument, a capture-emitter
 * call, a file-name literal's extension, the test path), is parsed with GitNexus's
 * `createParserForLanguage` and its anonymised tree hashed ({@link SourceShaper.syntaxProfile}):
 *  - names the tree declares itself ({@link declaredIn}: declaration nodes, for/range/assignment
 *    targets, Go `type_spec`) become `ID`;
 *  - external types and GitNexus builtin names (the string tables of the language providers under
 *    `gitnexus/src/core/ingestion/languages/`) stay, even when a fixture stubs them;
 *  - leaf rules apply to leaves only, so composites keep their structure;
 *  - literal values are dropped and literal kinds kept;
 *  - comment text is shaped ({@link shapeText}) for inline inputs and ignored in fixture files.
 * A parse with more than 20% error nodes was data, not code, and gives no profile.
 *
 * Rule 2, COBOL: the reserved words a literal uses ({@link COBOL_WORDS}).
 *
 * Rules 7 and 8, fixtures: {@link FixtureIndex} lists the fixture tree once (directories by name,
 * files by base name and by fixture-relative path); {@link SourceShaper.fixtureDefs} parses one
 * fixture directory (definitions with their full and header shapes, referenced names, type shapes
 * with their bases, declared field types) and {@link SourceShaper.fixtureFileShape} hashes one
 * fixture file.
 *
 * Library only; input-facet.ts owns one {@link SourceShaper} per run.
 */
import path from 'node:path';
import { SupportedLanguages } from 'gitnexus-shared';
import type Parser from 'tree-sitter';
import { getTreeSitterBufferSize } from '../../../src/core/ingestion/constants.js';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import { sha1 } from '../util.js';

type SyntaxNode = Parser.SyntaxNode;

/** Files at or above this size are not parsed. */
export const MAX_SOURCE_CHARS = 200_000;
/** A parse with a larger share of ERROR / missing nodes is data, not code. */
const MAX_ERROR_SHARE = 0.2;
/** Fixture directories are indexed by name this many levels below the fixture root. */
const FIXTURE_DIR_DEPTH = 4;

const sha12 = (text: string): string => sha1(text).slice(0, 12);

// ── Language detection ─────────────────────────────────────────────────────

const IDENT_LANG: ReadonlyMap<string, SupportedLanguages> = new Map([
  ['Rust', SupportedLanguages.Rust],
  ['Java', SupportedLanguages.Java],
  ['CSharp', SupportedLanguages.CSharp],
  ['Kotlin', SupportedLanguages.Kotlin],
  ['Go', SupportedLanguages.Go],
  ['Python', SupportedLanguages.Python],
  ['TypeScript', SupportedLanguages.TypeScript],
  ['JavaScript', SupportedLanguages.JavaScript],
  ['PHP', SupportedLanguages.PHP],
  ['Php', SupportedLanguages.PHP],
  ['Ruby', SupportedLanguages.Ruby],
  ['Swift', SupportedLanguages.Swift],
  ['Dart', SupportedLanguages.Dart],
  ['CPlusPlus', SupportedLanguages.CPlusPlus],
  ['Cpp', SupportedLanguages.CPlusPlus],
  ['CPP', SupportedLanguages.CPlusPlus],
  ['C', SupportedLanguages.C],
  ['Zig', SupportedLanguages.Zig],
  ['ObjectiveC', SupportedLanguages.ObjectiveC],
  ['Cobol', SupportedLanguages.Cobol],
]);

/** File extension → language, for fixture files and file-name literals. */
export const EXT_LANG: ReadonlyMap<string, SupportedLanguages> = new Map([
  ['rs', SupportedLanguages.Rust],
  ['java', SupportedLanguages.Java],
  ['cs', SupportedLanguages.CSharp],
  ['kt', SupportedLanguages.Kotlin],
  ['go', SupportedLanguages.Go],
  ['py', SupportedLanguages.Python],
  ['ts', SupportedLanguages.TypeScript],
  ['tsx', SupportedLanguages.TypeScript],
  ['js', SupportedLanguages.JavaScript],
  ['php', SupportedLanguages.PHP],
  ['rb', SupportedLanguages.Ruby],
  ['swift', SupportedLanguages.Swift],
  ['dart', SupportedLanguages.Dart],
  ['cpp', SupportedLanguages.CPlusPlus],
  ['cc', SupportedLanguages.CPlusPlus],
  ['hpp', SupportedLanguages.CPlusPlus],
  ['c', SupportedLanguages.C],
  ['h', SupportedLanguages.C],
  ['zig', SupportedLanguages.Zig],
  ['m', SupportedLanguages.ObjectiveC],
  ['cbl', SupportedLanguages.Cobol],
  ['cob', SupportedLanguages.Cobol],
]);

const CALL_LANG: readonly [RegExp, SupportedLanguages][] = [
  [/emitCppScopeCaptures|CPlusPlus/, SupportedLanguages.CPlusPlus],
  [/emitCScopeCaptures/, SupportedLanguages.C],
  [/emitJsScopeCaptures/, SupportedLanguages.JavaScript],
  [/emitTs\w*ScopeCaptures/, SupportedLanguages.TypeScript],
  [/\bcobol\(/, SupportedLanguages.Cobol],
];

const PATH_LANG: readonly [RegExp, SupportedLanguages][] = [
  [/\/cpp[-/]|cpp-captures/, SupportedLanguages.CPlusPlus],
  [/\/c\/|\/c-captures|c-coverage/, SupportedLanguages.C],
  [/cobol/, SupportedLanguages.Cobol],
  [/\/rust[-/.]|rust-/, SupportedLanguages.Rust],
  [/\/java[-/.]/, SupportedLanguages.Java],
  [/csharp/, SupportedLanguages.CSharp],
  [/kotlin/, SupportedLanguages.Kotlin],
  [/\/go[-/.]/, SupportedLanguages.Go],
  [/python/, SupportedLanguages.Python],
  [/typescript/, SupportedLanguages.TypeScript],
  [/javascript/, SupportedLanguages.JavaScript],
  [/\/php[-/.]/, SupportedLanguages.PHP],
  [/ruby/, SupportedLanguages.Ruby],
  [/swift/, SupportedLanguages.Swift],
  [/dart/, SupportedLanguages.Dart],
  [/zig/, SupportedLanguages.Zig],
];

const LANG_ARG =
  /,\s*(Rust|Java|CSharp|Kotlin|Go|Python|TypeScript|JavaScript|PHP|Php|Ruby|Swift|Dart|CPlusPlus|Cpp|CPP|Zig)\s*[,)]/;
const LANG_FIRST_ARG =
  /\(\s*(Rust|Java|CSharp|Kotlin|Go|Python|TypeScript|JavaScript|PHP|Ruby|Swift|Dart|CPlusPlus|Zig)\s*,/;

/**
 * The language a test feeds inline source in: named in its code (`text`), by a file-name literal,
 * or by its path (`testPath`, a repo path); null when none.
 */
export function languageOf(
  text: string,
  testPath: string,
  literals: readonly string[],
): SupportedLanguages | null {
  const named = /SupportedLanguages\.(\w+)/.exec(text);
  const byName = named === null ? undefined : IDENT_LANG.get(named[1]);
  if (byName !== undefined) return byName;
  for (const pattern of [LANG_ARG, LANG_FIRST_ARG]) {
    const match = pattern.exec(text);
    const lang = match === null ? undefined : IDENT_LANG.get(match[1]);
    if (lang !== undefined) return lang;
  }
  for (const [pattern, lang] of CALL_LANG) if (pattern.test(text)) return lang;
  for (const literal of literals) {
    const match = /^[\w./-]+\.(\w+)$/.exec(literal);
    const lang = match === null ? undefined : EXT_LANG.get(match[1]);
    if (lang !== undefined) return lang;
  }
  for (const [pattern, lang] of PATH_LANG) if (pattern.test(testPath)) return lang;
  return null;
}

// ── Literal shapes ─────────────────────────────────────────────────────────

/** A file path or a file name (`src/a.ts`, `a.ts`), never source code. */
export const PATHLIKE = /^[\w@.-]+(\/[\w@.-]+)+$|^[\w-]+\.\w{1,5}$/;

/** True when a literal may be inline source code rather than data. */
export const looksLikeSource = (text: string): boolean =>
  !PATHLIKE.test(text) && text.length >= 3 && (/\n/.test(text) || /[{}();=<>:[\]@#*/]/.test(text));

/**
 * The boundary-aware shape of a literal (design §5.3 rule 3): blank text keeps its length, `0`,
 * `1`, `-1` stay exact, other negatives read `NEG`, and letter / digit runs collapse:
 * `'User?'` → `'Aa?'`, `'ConcurrentHashMap'` → `'Aa'`, `'User | Repo'` → `'Aa | Aa'`.
 */
export function shapeText(text: string): string {
  if (/^\s*$/.test(text)) return `EMPTY(${text.length})`;
  if (/^-?[01]$/.test(text)) return `N${text}`;
  if (/^-\d/.test(text)) return 'NEG';
  return text
    .replace(/[A-Z][a-z]+/g, 'Aa')
    .replace(/[A-Z]+/g, 'A')
    .replace(/[a-z]+/g, 'a')
    .replace(/\d+/g, '0')
    .replace(/(Aa)+/g, 'Aa')
    .replace(/(A)+/g, 'A')
    .replace(/(a)+/g, 'a');
}

/** COBOL reserved words (rule 2). */
export const COBOL_WORDS: ReadonlySet<string> = new Set(
  (
    'PERFORM THRU THROUGH UNTIL VARYING TIMES WITH TEST BEFORE AFTER CALL USING RETURNING BY ' +
    'REFERENCE CONTENT VALUE MOVE TO IF ELSE END-IF EVALUATE WHEN OTHER END-EVALUATE COPY ' +
    'REPLACING EXEC SQL CICS END-EXEC DIVISION SECTION PROCEDURE DATA WORKING-STORAGE ' +
    'LOCAL-STORAGE LINKAGE FILE FD SD SELECT ASSIGN PIC PICTURE OCCURS REDEFINES RENAMES GO ' +
    'GOBACK STOP RUN DISPLAY ACCEPT COMPUTE ADD SUBTRACT MULTIPLY DIVIDE INITIALIZE STRING ' +
    'UNSTRING INSPECT SET OPEN CLOSE READ WRITE REWRITE DELETE START ENTRY PROGRAM-ID ' +
    'IDENTIFICATION ENVIRONMENT CONFIGURATION INPUT-OUTPUT NOT AND OR END-PERFORM END-CALL ' +
    'END-READ EXIT CONTINUE NESTED INITIAL COMMON RECURSIVE FUNCTION-ID CLASS-ID METHOD-ID ' +
    'INVOKE END-PROGRAM 88 LEVEL SEARCH ALL SORT MERGE RELEASE RETURN'
  ).split(' '),
);

/** The distinct COBOL reserved words of a text, upper-cased, in first-seen order. */
export const cobolWords = (text: string): string[] =>
  [...new Set(text.toUpperCase().match(/[A-Z][A-Z-]*/g) ?? [])].filter((word) =>
    COBOL_WORDS.has(word),
  );

// ── Tree shapes ────────────────────────────────────────────────────────────

const DECLARATION =
  /declaration|definition|declarator|parameter|binding|pattern|item|_spec$|type_alias|^(class|struct|union|enum)_specifier$/;
const TARGET_OWNER = /for|assignment|with|catch|except|let|var|range/;
const NAME_LEAF = /identifier$|^name$|_name$|^simple_identifier$|^type_identifier$/;
const LITERAL_TYPE = /literal|^true$|^false$|^null$|^nil$|^none$|^boolean$/;
const LITERAL_PART = /content|escape|fragment|character|^true$|^false$/;

function children(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child !== null) out.push(child);
  }
  return out;
}

function namedChildren(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child !== null) out.push(child);
  }
  return out;
}

/** The innermost `declarator` of a C-style declaration. */
function innermostDeclarator(node: SyntaxNode): SyntaxNode | null {
  let declarator = node.childForFieldName('declarator');
  while (declarator !== null && declarator.childForFieldName('declarator') !== null) {
    declarator = declarator.childForFieldName('declarator');
  }
  return declarator;
}

/** Names a tree declares itself (functions, classes, variables, parameters, loop targets). */
export function declaredIn(root: SyntaxNode, into: Set<string> = new Set()): Set<string> {
  const identifiersOf = (node: SyntaxNode): void => {
    if (/identifier/.test(node.type)) into.add(node.text);
    for (const child of children(node)) identifiersOf(child);
  };
  const visit = (node: SyntaxNode): void => {
    if (DECLARATION.test(node.type)) {
      const name = node.childForFieldName('name');
      if (name !== null) into.add(name.text);
      const declarator = innermostDeclarator(node);
      if (declarator !== null && /identifier/.test(declarator.type)) into.add(declarator.text);
      const first = namedChildren(node).find((child) =>
        /^(simple_identifier|identifier|type_identifier)$/.test(child.type),
      );
      if (first !== undefined) into.add(first.text);
    }
    if (TARGET_OWNER.test(node.type)) {
      const target =
        node.childForFieldName('left') ??
        node.childForFieldName('pattern') ??
        node.childForFieldName('name') ??
        node.childForFieldName('variable');
      if (target !== null) identifiersOf(target);
    }
    for (const child of children(node)) visit(child);
  };
  visit(root);
  return into;
}

export interface ShapeOptions {
  /** Names the shaped tree (or fixture directory) declares; undefined keeps no name. */
  declared: ReadonlySet<string> | undefined;
  /** GitNexus builtin names, kept as `X:<name>`. */
  builtins: ReadonlySet<string>;
  /** `text` shapes comments (inline inputs); `ignore` drops them (fixture files). */
  comments: 'text' | 'ignore';
}

/**
 * The anonymised shape of a tree: declared names → `ID`, external types and builtins kept,
 * literal values dropped (kinds kept), keyword tokens kept. `skipField` drops one child field of
 * the root (a definition's `body`, for header shapes).
 */
export function shapeOf(node: SyntaxNode, options: ShapeOptions, skipField?: string): string {
  const named = node.isNamed;
  if (named && /comment/.test(node.type)) {
    return options.comments === 'ignore' ? '' : `C[${shapeText(node.text)}]`;
  }
  if (named && node.namedChildCount === 0 && NAME_LEAF.test(node.type)) {
    // External types and library builtins carry meaning; undeclared placeholders do not.
    const typeish = /type|namespace/.test(node.type) || node.parent?.type === 'user_type';
    // A fixture stub of a library type (namespace std { class vector {}; }) still stands for it.
    if (typeish && options.builtins.has(node.text)) return `X:${node.text}`;
    const external =
      options.declared !== undefined && !options.declared.has(node.text) && node.text.length > 1;
    const meaningful = typeish || options.builtins.has(node.text);
    return external && meaningful ? `X:${node.text}` : 'ID';
  }
  if (!named) return /^[a-z_@#]+$/i.test(node.type) ? `'${node.type}'` : node.type;
  if (LITERAL_TYPE.test(node.type)) {
    const leaf = children(node).every((child) => !child.isNamed || LITERAL_PART.test(child.type));
    if (leaf) return node.type;
  }
  const kids: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child === null) continue;
    if (skipField !== undefined && node.fieldNameForChild(i) === skipField) continue;
    kids.push(shapeOf(child, options));
  }
  return kids.length > 0 ? `${node.type}(${kids.join(' ')})` : node.type;
}

function errorShare(root: SyntaxNode): number {
  let nodes = 0;
  let errors = 0;
  const count = (node: SyntaxNode): void => {
    nodes++;
    if (node.type === 'ERROR' || node.isMissing) errors++;
    for (const child of children(node)) count(child);
  };
  count(root);
  return errors / nodes;
}

// ── Fixtures ───────────────────────────────────────────────────────────────

/** Repo-path file listing and reading, shared with the facet context. */
export interface SourceReader {
  /** Text of a repo path, null when it cannot be read. */
  read(repoPath: string): string | null;
  /** Repo paths of the files under a repo directory, recursively, sorted. */
  list(repoDir: string): string[];
}

/** The fixture tree: directories by name, files by base name and fixture-relative path. */
export class FixtureIndex {
  readonly dirs = new Map<string, string[]>();
  readonly files = new Map<string, string[]>();

  constructor(
    readonly root: string,
    files: readonly string[],
  ) {
    const push = (map: Map<string, string[]>, key: string, value: string): void => {
      const list = map.get(key) ?? [];
      if (!list.includes(value)) list.push(value);
      map.set(key, list);
    };
    for (const file of [...files].sort()) {
      const relative = path.posix.relative(root, file);
      push(this.files, path.posix.basename(file), file);
      push(this.files, relative, file);
      const segments = relative.split('/').slice(0, -1);
      for (let depth = 0; depth < Math.min(segments.length, FIXTURE_DIR_DEPTH); depth++) {
        push(this.dirs, segments[depth], path.posix.join(root, ...segments.slice(0, depth + 1)));
      }
    }
  }
}

export interface FixtureDef {
  /** sha of the definition's shape. */
  full: string;
  /** sha of the shape without its body. */
  header: string;
  /** Tree-sitter node type. */
  kind: string;
  /** Identifiers the definition mentions. */
  refs: ReadonlySet<string>;
}

export interface FixtureDefs {
  /** Function / method / constructor name → its definitions. */
  names: Map<string, FixtureDef[]>;
  /** Directory-relative path → sha of the file's shape. */
  files: Map<string, string>;
  /** Type name → its shape and the names its header mentions (bases). */
  types: Map<string, { shape: string; bases: ReadonlySet<string> }>;
  /** Field name → `<sha of the declared type>:<shape of that type or ->`. */
  fields: Map<string, string[]>;
}

const TYPE_DECL =
  /class|struct|interface|enum|record|object_declaration|trait_item|impl_item|type_spec|protocol/;
const FIELD_DECL = /field_declaration|property_declaration|field_definition/;

function identifiersIn(node: SyntaxNode, skipField?: string): Set<string> {
  const out = new Set<string>();
  const walk = (current: SyntaxNode, top: boolean): void => {
    if (/identifier/.test(current.type)) out.add(current.text);
    for (let i = 0; i < current.childCount; i++) {
      const child = current.child(i);
      if (child === null) continue;
      if (top && skipField !== undefined && current.fieldNameForChild(i) === skipField) continue;
      walk(child, false);
    }
  };
  walk(node, true);
  return out;
}

function definitionName(node: SyntaxNode): string | null {
  let name = node.childForFieldName('name')?.text ?? null;
  if (name === null) {
    // C/C++: function_definition → declarator → … → identifier / qualified name.
    const declarator = innermostDeclarator(node);
    const leaf = declarator?.childForFieldName('name') ?? declarator;
    name = leaf?.text.split('::').pop() ?? null;
  }
  if (name === null || /[\s(]/.test(name)) {
    const first = namedChildren(node).find((child) =>
      /^(simple_identifier|identifier)$/.test(child.type),
    );
    if (first !== undefined) name = first.text;
  }
  return name;
}

/** Tree-sitter parsers by language and the shapes built on them, for one run. */
export class SourceShaper {
  private readonly parsers = new Map<SupportedLanguages, Parser | null>();
  private readonly defsCache = new Map<string, FixtureDefs>();
  private readonly fileShapes = new Map<string, string | null>();

  constructor(
    private readonly reader: SourceReader,
    private readonly builtins: () => ReadonlySet<string>,
  ) {}

  /** A parser for `lang` (TypeScript parses as TSX); null when the grammar is unavailable. */
  async parserFor(lang: SupportedLanguages): Promise<Parser | null> {
    if (!this.parsers.has(lang)) {
      try {
        const variant = lang === SupportedLanguages.TypeScript ? 'x.tsx' : undefined;
        this.parsers.set(lang, await createParserForLanguage(lang, variant));
      } catch {
        this.parsers.set(lang, null);
      }
    }
    return this.parsers.get(lang) ?? null;
  }

  private async parse(lang: SupportedLanguages, text: string): Promise<SyntaxNode | null> {
    const parser = await this.parserFor(lang);
    if (parser === null) return null;
    try {
      return parser.parse(text, null, { bufferSize: getTreeSitterBufferSize(text) }).rootNode;
    } catch {
      return null;
    }
  }

  /**
   * Rule 1 / rule 2: the profile of inline source in `lang`, `shape:<sha>` (or `cobol:<words>`);
   * null when it does not parse as code.
   */
  async syntaxProfile(lang: SupportedLanguages, source: string): Promise<string | null> {
    if (lang === SupportedLanguages.Cobol) {
      const words = cobolWords(source);
      return words.length > 0 ? `cobol:${words.sort().join(',')}` : null;
    }
    const root = await this.parse(lang, source.replace(/__X__/g, 'x'));
    if (root === null || errorShare(root) > MAX_ERROR_SHARE) return null;
    const options: ShapeOptions = {
      declared: declaredIn(root),
      builtins: this.builtins(),
      comments: 'text',
    };
    return `shape:${sha12(shapeOf(root, options))}`;
  }

  /** Rule 8: the shape of one fixture file (repo path); null when it cannot be shaped. */
  async fixtureFileShape(file: string): Promise<string | null> {
    const cached = this.fileShapes.get(file);
    if (cached !== undefined) return cached;
    let shape: string | null = null;
    const text = this.reader.read(file);
    if (text !== null && text.length < MAX_SOURCE_CHARS) {
      const lang = EXT_LANG.get(path.posix.extname(file).slice(1));
      if (lang !== undefined && lang !== SupportedLanguages.Cobol) {
        const root = await this.parse(lang, text);
        const options: ShapeOptions = {
          declared: root === null ? undefined : declaredIn(root),
          builtins: this.builtins(),
          comments: 'ignore',
        };
        shape = root === null ? null : sha12(shapeOf(root, options));
      } else shape = sha12(text.replace(/\s+/g, ' '));
    }
    this.fileShapes.set(file, shape);
    return shape;
  }

  /** Rule 7: the definitions, types and fields of one fixture directory (repo path). */
  async fixtureDefs(dir: string): Promise<FixtureDefs> {
    const cached = this.defsCache.get(dir);
    if (cached !== undefined) return cached;
    const defs: FixtureDefs = {
      names: new Map(),
      files: new Map(),
      types: new Map(),
      fields: new Map(),
    };
    this.defsCache.set(dir, defs);
    const parsed: { file: string; root: SyntaxNode }[] = [];
    for (const file of this.reader.list(dir)) {
      const lang = EXT_LANG.get(path.posix.extname(file).slice(1));
      if (lang === undefined || lang === SupportedLanguages.Cobol) continue;
      const text = this.reader.read(file);
      if (text === null || text.length >= MAX_SOURCE_CHARS) continue;
      const root = await this.parse(lang, text);
      if (root !== null) parsed.push({ file, root });
    }
    const declared = new Set<string>();
    for (const { root } of parsed) declaredIn(root, declared);
    const options: ShapeOptions = { declared, builtins: this.builtins(), comments: 'ignore' };
    const profile = (node: SyntaxNode): string => sha12(shapeOf(node, options));
    const header = (node: SyntaxNode): string => sha12(shapeOf(node, options, 'body'));
    const fieldTypes = new Map<string, SyntaxNode[]>();
    const push = <T>(map: Map<string, T[]>, key: string, value: T): void => {
      const list = map.get(key) ?? [];
      list.push(value);
      map.set(key, list);
    };
    for (const { file, root } of parsed) {
      defs.files.set(path.posix.relative(dir, file), profile(root));
      const visit = (node: SyntaxNode): void => {
        const isType =
          (TYPE_DECL.test(node.type) && !/body|list|specifier$/.test(node.type)) ||
          /^(class|struct|union|enum)_specifier$/.test(node.type);
        if (isType) {
          const name =
            node.childForFieldName('name')?.text ??
            namedChildren(node).find((child) => /identifier/.test(child.type))?.text;
          if (name !== undefined && !defs.types.has(name)) {
            defs.types.set(name, { shape: profile(node), bases: identifiersIn(node, 'body') });
          }
        }
        if (FIELD_DECL.test(node.type)) {
          const type = node.childForFieldName('type');
          const nameNode = node.childForFieldName('name') ?? node.childForFieldName('declarator');
          if (type !== null && nameNode !== null) {
            push(fieldTypes, nameNode.text.replace(/[^\w$].*$/, ''), type);
          }
        }
        if (
          /function|method|constructor/.test(node.type) &&
          !/call|invocation|reference/.test(node.type)
        ) {
          const name = definitionName(node);
          if (name !== null) {
            push(defs.names, name, {
              full: profile(node),
              header: header(node),
              kind: node.type,
              refs: identifiersIn(node),
            });
          }
        }
        for (const child of children(node)) visit(child);
      };
      visit(root);
    }
    for (const [name, types] of fieldTypes) {
      defs.fields.set(
        name,
        types.map((type) => {
          const leaf = type.text.replace(/[*&[\]\s]|^.*\./g, '');
          return `${profile(type)}:${defs.types.get(leaf)?.shape ?? '-'}`;
        }),
      );
    }
    return defs;
  }
}
