/**
 * Literal collectors for the node-type / field validation gate (issue #1920).
 *
 * Collects every tree-sitter node-type and field-name literal the ingestion
 * layer references in CODE (the query strings themselves are validated by
 * compilation — see Mode 3 and query-compilation.test.ts), each tagged with
 * the grammar language(s) it is checked against.
 *
 * FOUR modes (plan KTD3):
 *   1. Config reflection — import `*-extractors/configs/*.ts`, read each
 *      config-shaped export's node-type-array keys. Exact `config.language`.
 *   2. AST scan (`typescript` parser, no type-checker) over the EXTRACTION
 *      surface — `*-extractors/**`, every `languages/<lang>/captures.ts`, and
 *      `export-detection.ts`. Collected BY CONSUMPTION SITE: `<n>.type === '..'`,
 *      `childForFieldName('..')` (capturing the receiver node type when an
 *      enclosing `recv.type === 'X'` guard / `case 'X':` narrows it — see
 *      `receiverNodeTypeOf`), `findNodeAtRange(.., '..')`, and members of a
 *      `Set`/array consumed via `SET.has(<n>.type)`. No `*_TYPES` name heuristic:
 *      a `Set`'s members are collected only when consumed against a node's `.type`.
 *   3. Registry scope-query probes — invoke each `languages/<lang>/query.ts`
 *      `get*ScopeQuery()` (gated by `isLanguageAvailable`) so the gate compiles
 *      the registry scope queries too (new coverage vs query-compilation.test.ts).
 *   4. Resolution-layer scan (TypeChecker-gated) — the registry production path
 *      (`languages/<lang>/{scope-resolver,type-binding,receiver-binding,interpret,
 *      arity,import-decomposer,…}`) PLUS shared resolution files directly under
 *      `ingestion/` (e.g. `type-env.ts`). These files MIX SyntaxNode `.type` with
 *      resolved-symbol `.type` (kinds like 'Class'), so a literal is collected
 *      ONLY when its `.type` / `childForFieldName` receiver resolves to a
 *      tree-sitter SyntaxNode (via the TS TypeChecker). Per-`languages/<lang>/`
 *      files tag to that one grammar; shared (non-`languages/<lang>/`) files tag
 *      to the full gated set (valid-if-any).
 *
 * (In-file section order is 1, 2, 4, 3 for historical reasons; the logical order
 * is as numbered above.)
 *
 * Test-only file: allowed to name languages.
 */
import ts from 'typescript';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';
import { GATED_LANGUAGES } from './grammar-introspection.js';

const INGESTION_DIR = fileURLToPath(new URL('../../src/core/ingestion/', import.meta.url));

export interface CollectedNodeType {
  literal: string;
  languages: SupportedLanguages[];
  file: string; // ingestion-relative
  line: number;
  source: 'config' | 'compare' | 'set-member' | 'find-node-arg';
}
export interface CollectedField {
  field: string;
  languages: SupportedLanguages[];
  file: string;
  line: number;
  /** Receiver node type when statically narrowed by an enclosing positive guard
   *  (`if (recv.type === 'X')` / `case 'X':`). When set, the gate validates the
   *  field node-scoped (membership-then-probe); otherwise it uses the sound
   *  global existence check. See `receiverNodeTypeOf` / KTD2. */
  receiverNodeType?: string;
}
export interface RegistryQueryProbe {
  language: SupportedLanguages;
  getter: string;
  error: string | null;
}

const ALL_LANGS = GATED_LANGUAGES;

/** Directory name (under languages/) → language. */
const DIR_LANG: Record<string, SupportedLanguages> = {
  javascript: SupportedLanguages.JavaScript,
  typescript: SupportedLanguages.TypeScript,
  python: SupportedLanguages.Python,
  java: SupportedLanguages.Java,
  c: SupportedLanguages.C,
  cpp: SupportedLanguages.CPlusPlus,
  csharp: SupportedLanguages.CSharp,
  go: SupportedLanguages.Go,
  ruby: SupportedLanguages.Ruby,
  rust: SupportedLanguages.Rust,
  php: SupportedLanguages.PHP,
  kotlin: SupportedLanguages.Kotlin,
  swift: SupportedLanguages.Swift,
  dart: SupportedLanguages.Dart,
  vue: SupportedLanguages.Vue,
};

/** Basename (no .ts) → language set, for extractor files that name a language. */
const BASENAME_LANGS: Record<string, SupportedLanguages[]> = {
  'c-cpp': [SupportedLanguages.C, SupportedLanguages.CPlusPlus],
  jvm: [SupportedLanguages.Java, SupportedLanguages.Kotlin],
  'typescript-javascript': [SupportedLanguages.TypeScript, SupportedLanguages.JavaScript],
  csharp: [SupportedLanguages.CSharp],
  dart: [SupportedLanguages.Dart],
  go: [SupportedLanguages.Go],
  php: [SupportedLanguages.PHP],
  python: [SupportedLanguages.Python],
  ruby: [SupportedLanguages.Ruby],
  rust: [SupportedLanguages.Rust],
  swift: [SupportedLanguages.Swift],
  typescript: [SupportedLanguages.TypeScript],
  javascript: [SupportedLanguages.JavaScript],
  java: [SupportedLanguages.Java],
  kotlin: [SupportedLanguages.Kotlin],
  laravel: [SupportedLanguages.PHP],
  nextjs: [SupportedLanguages.TypeScript, SupportedLanguages.JavaScript],
  expo: [SupportedLanguages.TypeScript, SupportedLanguages.JavaScript],
  'fastapi-router-bindings': [SupportedLanguages.Python],
};

/** const-name prefix → language (for export-detection.ts style named sets). */
const PREFIX_LANGS: Record<string, SupportedLanguages[]> = {
  CSHARP: [SupportedLanguages.CSharp],
  RUST: [SupportedLanguages.Rust],
  GO: [SupportedLanguages.Go],
  JAVA: [SupportedLanguages.Java],
  KOTLIN: [SupportedLanguages.Kotlin],
  PYTHON: [SupportedLanguages.Python],
  RUBY: [SupportedLanguages.Ruby],
  PHP: [SupportedLanguages.PHP],
  SWIFT: [SupportedLanguages.Swift],
  DART: [SupportedLanguages.Dart],
  CPP: [SupportedLanguages.CPlusPlus],
  TS: [SupportedLanguages.TypeScript],
  JS: [SupportedLanguages.JavaScript],
};

/** Candidate grammar languages a CODE literal in `relPath` should be checked against. */
function fileLanguages(relPath: string): SupportedLanguages[] {
  const langsMatch = relPath.match(/(?:^|\/)languages\/([^/]+)\//);
  if (langsMatch) {
    const lang = DIR_LANG[langsMatch[1]];
    return lang ? [lang] : [...ALL_LANGS];
  }
  const base = relPath.replace(/\.ts$/, '').split('/').pop() ?? '';
  if (BASENAME_LANGS[base]) return BASENAME_LANGS[base];
  // A `<lang>-harvest.ts` CFG def/use harvester is validated against the SAME
  // grammar(s) as its `<lang>.ts` CFG visitor (go-harvest → Go, c-cpp-harvest →
  // C+C++, typescript-harvest → TS, …) — strip the suffix and reuse the visitor
  // basename map. The two genuinely language-agnostic harvesters —
  // call-site-harvest.ts (pure taint-site mechanism) and scope-tree-harvest.ts
  // (shared lexical-scope substrate) — name no grammar, so their stripped base
  // (`call-site`, `scope-tree`) misses BASENAME_LANGS and they fall through to
  // the valid-if-any ALL_LANGS bucket below (correct: they pin no per-grammar
  // literal).
  const harvestBase = base.replace(/-harvest$/, '');
  if (harvestBase !== base && BASENAME_LANGS[harvestBase]) return BASENAME_LANGS[harvestBase];
  // generic / shared / cross-language helpers → any grammar (valid-if-any)
  return [...ALL_LANGS];
}

/** Narrow a Set's candidate languages by a `<LANG>_...` const-name prefix. */
function constNameLanguages(
  constName: string,
  fallback: SupportedLanguages[],
): SupportedLanguages[] {
  const m = constName.match(/^([A-Z]+)_/);
  if (m && PREFIX_LANGS[m[1]]) return PREFIX_LANGS[m[1]];
  return fallback;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------
function walkTs(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkTs(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
}

/** The Mode-2 scan surface: every *-extractors/** file + each captures.ts + export-detection.ts. */
function mode2Files(): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(INGESTION_DIR)) {
    if (entry.endsWith('-extractors')) walkTs(join(INGESTION_DIR, entry), files);
  }
  const langsDir = join(INGESTION_DIR, 'languages');
  if (existsSync(langsDir)) {
    for (const lang of readdirSync(langsDir)) {
      if (lang === 'cobol') continue;
      const cap = join(langsDir, lang, 'captures.ts');
      if (existsSync(cap)) files.push(cap);
    }
  }
  // CFG visitors (cfg/visitors/<lang>.ts) AND their def/use harvesters
  // (cfg/visitors/<lang>-harvest.ts) hard-code tree-sitter node-type and field
  // literals directly; include them so the gate validates per-language CFG
  // literals against the right grammar (basename → grammar via `fileLanguages`:
  // c-cpp[-harvest] → C+C++, csharp[-harvest] → C#, go[-harvest] → Go,
  // typescript[-harvest] → TS, …; the language-agnostic call-site-harvest.ts and
  // scope-tree-harvest.ts carry no grammar literal and stay valid-if-any).
  // Without this, the gate stays green on a dead literal in a new visitor or
  // harvester — the exact failure KTD5 warns about.
  const cfgVisitorsDir = join(INGESTION_DIR, 'cfg', 'visitors');
  if (existsSync(cfgVisitorsDir)) walkTs(cfgVisitorsDir, files);
  const exportDetection = join(INGESTION_DIR, 'export-detection.ts');
  if (existsSync(exportDetection)) files.push(exportDetection);
  return files;
}

/** The config files for Mode-1 reflection. */
function configFiles(): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(INGESTION_DIR)) {
    if (!entry.endsWith('-extractors')) continue;
    const cfgDir = join(INGESTION_DIR, entry, 'configs');
    if (existsSync(cfgDir)) walkTs(cfgDir, files);
  }
  return files;
}

const rel = (abs: string): string => abs.slice(INGESTION_DIR.length);

// ---------------------------------------------------------------------------
// Mode 1 — config reflection
// ---------------------------------------------------------------------------
const CONFIG_NODE_TYPE_KEYS = new Set([
  'typeDeclarationNodes',
  'methodNodeTypes',
  'bodyNodeTypes',
  'fieldNodeTypes',
  'variableNodeTypes',
  'staticNodeTypes',
  'constNodeTypes',
  'ancestorScopeNodeTypes',
  'fileScopeNodeTypes',
  'enumNodeTypes',
  'propertyNodeTypes',
]);

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

async function collectConfigNodeTypes(): Promise<CollectedNodeType[]> {
  const out: CollectedNodeType[] = [];
  for (const file of configFiles()) {
    const relPath = rel(file);
    let mod: Record<string, unknown>;
    try {
      // import the compiled .js sibling (vitest transpiles src on import)
      mod = (await import(file)) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const exported of Object.values(mod)) {
      if (!exported || typeof exported !== 'object') continue;
      const cfg = exported as Record<string, unknown>;
      const lang = cfg.language;
      if (typeof lang !== 'string' || !ALL_LANGS.includes(lang as SupportedLanguages)) continue;
      // Tag by the config FILE's served language set, not the single config
      // object's `.language`: a shared file (typescript-javascript, c-cpp, jvm)
      // legitimately lists nodes valid in a sibling grammar, so a node valid in
      // ANY served language must not be flagged dead. Union the object's own
      // language in case the file map is broader/narrower.
      const fileLangs = fileLanguages(relPath);
      const languages = fileLangs.includes(lang as SupportedLanguages)
        ? fileLangs
        : [...fileLangs, lang as SupportedLanguages];
      for (const [key, value] of Object.entries(cfg)) {
        if (!CONFIG_NODE_TYPE_KEYS.has(key) || !isStringArray(value)) continue;
        for (const literal of value) {
          out.push({ literal, languages, file: relPath, line: 0, source: 'config' });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mode 2 — AST scan
// ---------------------------------------------------------------------------
const FIELD_LOOKUP_NAMES = new Set(['childForFieldName', 'childrenForFieldName']);
const MEMBERSHIP_NAMES = new Set(['has', 'includes']);

/** Is `node` a `<expr>.type` property access? */
function isDotType(node: ts.Node): node is ts.PropertyAccessExpression {
  return ts.isPropertyAccessExpression(node) && node.name.text === 'type';
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

interface ScanResult {
  nodeTypes: CollectedNodeType[];
  fields: CollectedField[];
}

/** Extract string members of `new Set([...])` / `[...]` / `[...] as const`, or null if not a literal string array. */
function collectConstMembers(init: ts.Expression): string[] | null {
  let arr: ts.Expression | undefined;
  if (ts.isNewExpression(init) && init.arguments && init.arguments.length > 0) {
    arr = init.arguments[0];
  } else if (ts.isArrayLiteralExpression(init)) {
    arr = init;
  } else if (ts.isAsExpression(init)) {
    return collectConstMembers(init.expression);
  }
  if (arr && ts.isArrayLiteralExpression(arr)) {
    const members = arr.elements
      .filter((e): e is ts.StringLiteral => ts.isStringLiteral(e))
      .map((e) => e.text);
    return members.length === arr.elements.length ? members : null;
  }
  return null;
}

// ── Receiver-node-type capture (KTD2) ──────────────────────────────────────
function isFunctionLikeNode(n: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n)
  );
}

function rangeContains(outer: ts.Node, inner: ts.Node): boolean {
  return inner.getStart() >= outer.getStart() && inner.getEnd() <= outer.getEnd();
}

function enclosingFunctionOf(node: ts.Node): ts.Node | undefined {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (isFunctionLikeNode(cur)) return cur;
    cur = cur.parent;
  }
  return undefined;
}

/** True if `recvText` is reassigned, mutated (++/--), or re-declared (shadowed) within `scope`. */
function receiverMutatedIn(recvText: string, scope: ts.Node): boolean {
  let mutated = false;
  const walk = (n: ts.Node): void => {
    if (mutated) return;
    if (
      ts.isBinaryExpression(n) &&
      n.left.getText() === recvText &&
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      mutated = true;
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken ||
        n.operator === ts.SyntaxKind.MinusMinusToken) &&
      n.operand.getText() === recvText
    ) {
      mutated = true;
      return;
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === recvText) {
      mutated = true; // re-declaration / shadow
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(scope);
  return mutated;
}

/**
 * Conservative receiver-node-type capture for `recv.childForFieldName('field')`.
 * Returns X only when `recv` is unambiguously narrowed by a single enclosing
 * positive guard — `if (recv.type === 'X') {…}` (then-branch only) or
 * `switch (recv.type) { case 'X': … }` — and the receiver is not reassigned or
 * shadowed within the enclosing function. Any uncertainty → undefined, so the
 * gate falls back to the sound global field check. Fail-safe by design: the
 * failure mode is a benign false negative, never a false positive (KTD2).
 */
function receiverNodeTypeOf(call: ts.CallExpression, sf: ts.SourceFile): string | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const recvText = call.expression.expression.getText(sf);

  const isRecvDotType = (e: ts.Node): boolean =>
    ts.isPropertyAccessExpression(e) &&
    e.name.text === 'type' &&
    e.expression.getText(sf) === recvText;
  const bareEq = (e: ts.Expression): string | undefined => {
    if (
      ts.isBinaryExpression(e) &&
      e.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    ) {
      const lit = ts.isStringLiteralLike(e.left)
        ? e.left
        : ts.isStringLiteralLike(e.right)
          ? e.right
          : undefined;
      if (lit && (isRecvDotType(e.left) || isRecvDotType(e.right))) return lit.text;
    }
    return undefined;
  };

  let found: string | undefined;
  let enclosingFn: ts.Node | undefined;
  let cur: ts.Node = call;
  while (cur.parent) {
    const p: ts.Node = cur.parent;
    if (
      ts.isIfStatement(p) &&
      rangeContains(p.thenStatement, call) &&
      !(p.elseStatement !== undefined && rangeContains(p.elseStatement, call))
    ) {
      const x = bareEq(p.expression);
      if (x !== undefined) {
        found = x;
        break;
      }
    } else if (ts.isCaseClause(p)) {
      const sw = p.parent.parent;
      if (
        ts.isSwitchStatement(sw) &&
        isRecvDotType(sw.expression) &&
        ts.isStringLiteralLike(p.expression)
      ) {
        found = p.expression.text;
        break;
      }
    }
    if (isFunctionLikeNode(p)) {
      enclosingFn = p;
      break;
    }
    cur = p;
  }
  if (found === undefined) return undefined;
  const scope = enclosingFn ?? enclosingFunctionOf(call) ?? sf;
  return receiverMutatedIn(recvText, scope) ? undefined : found;
}

function scanFile(file: string): ScanResult {
  const relPath = rel(file);
  const langs = fileLanguages(relPath);
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const nodeTypes: CollectedNodeType[] = [];
  const fields: CollectedField[] = [];

  // First pass: index module-level string Set/array consts, and record which
  // const identifiers are consumed via `SET.has(<n>.type)` / `.includes(<n>.type)`.
  const constMembers = new Map<string, string[]>();
  const typeConsumed = new Set<string>();

  const visit = (node: ts.Node): void => {
    // module-level const Set/array of strings
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const members = collectConstMembers(node.initializer);
      if (members) constMembers.set(node.name.text, members);
    }

    // `<n>.type === 'lit'` / `!==`
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      const { left, right } = node;
      const lit = ts.isStringLiteral(left) ? left : ts.isStringLiteral(right) ? right : null;
      const dot = isDotType(left) ? left : isDotType(right) ? right : null;
      if (lit && dot) {
        nodeTypes.push({
          literal: lit.text,
          languages: langs,
          file: relPath,
          line: lineOf(sf, lit),
          source: 'compare',
        });
      }
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const arg0 = node.arguments[0];
      // childForFieldName('field')
      if (FIELD_LOOKUP_NAMES.has(method) && arg0 && ts.isStringLiteral(arg0)) {
        fields.push({
          field: arg0.text,
          languages: langs,
          file: relPath,
          line: lineOf(sf, arg0),
          receiverNodeType: receiverNodeTypeOf(node, sf),
        });
      }
      // SET.has(<n>.type) / SET.includes(<n>.type) → mark the receiver set
      if (
        MEMBERSHIP_NAMES.has(method) &&
        arg0 &&
        isDotType(arg0) &&
        ts.isIdentifier(node.expression.expression)
      ) {
        typeConsumed.add(node.expression.expression.text);
      }
    }

    // findNodeAtRange(a, b, 'lit') — 3rd arg, literal only (skip dynamic)
    if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === 'findNodeAtRange') ||
        (ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'findNodeAtRange'))
    ) {
      const a2 = node.arguments[2];
      if (a2 && ts.isStringLiteral(a2)) {
        nodeTypes.push({
          literal: a2.text,
          languages: langs,
          file: relPath,
          line: lineOf(sf, a2),
          source: 'find-node-arg',
        });
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);

  // Second pass: emit members of every set that was consumed against `.type`.
  for (const constName of typeConsumed) {
    const members = constMembers.get(constName);
    if (!members) continue; // imported or non-literal set — skip (sound: don't guess)
    const memberLangs = constNameLanguages(constName, langs);
    for (const literal of members) {
      nodeTypes.push({
        literal,
        languages: memberLangs,
        file: relPath,
        line: 0,
        source: 'set-member',
      });
    }
  }

  return { nodeTypes, fields };
}

function collectInCodeLiterals(): ScanResult {
  const nodeTypes: CollectedNodeType[] = [];
  const fields: CollectedField[] = [];
  for (const file of mode2Files()) {
    const r = scanFile(file);
    nodeTypes.push(...r.nodeTypes);
    fields.push(...r.fields);
  }
  return { nodeTypes, fields };
}

// ---------------------------------------------------------------------------
// Mode 4 — registry RESOLUTION layer (scope-resolver/type-binding/receiver-
// binding/interpret/arity/import-decomposer/...), the production path for
// migrated languages. These files mix SyntaxNode `.type` (grammar nodes) with
// resolved-symbol `.type` (kinds like 'Class'); a naive scan would false-
// positive on the latter. So this mode uses the TS TypeChecker to collect a
// literal ONLY when its `.type` receiver / childForFieldName target resolves to
// a tree-sitter SyntaxNode. Per-language dir => grammar (no cross-lang ambiguity).
// ---------------------------------------------------------------------------
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RES_SKIP = new Set(['captures.ts', 'query.ts', 'index.ts']);
const NODE_ARG_FNS = new Set(['findChild', 'findNamedChild', 'findSiblingChild']);
/**
 * Shared resolution-layer files directly under ingestion/ (NOT in
 * `languages/<lang>/`). They mix SyntaxNode `.type` with resolved-symbol `.type`,
 * so they belong in the TypeChecker-gated Mode 4; being language-agnostic, they
 * are tagged with the full gated set (valid-if-any). See KTD3.
 */
const SHARED_RESOLUTION_FILES = ['type-env.ts'];

function resolutionLayerFiles(): { file: string; langs: SupportedLanguages[] }[] {
  const out: { file: string; langs: SupportedLanguages[] }[] = [];
  const langsDir = join(INGESTION_DIR, 'languages');
  // Per-language registry resolution files → tagged to that one grammar.
  if (existsSync(langsDir)) {
    for (const dir of readdirSync(langsDir)) {
      if (dir === 'cobol') continue;
      const lang = DIR_LANG[dir];
      if (!lang) continue;
      const d = join(langsDir, dir);
      if (!statSync(d).isDirectory()) continue;
      const sub: string[] = [];
      walkTs(d, sub);
      for (const f of sub) {
        if (!RES_SKIP.has(f.split('/').pop() ?? '')) out.push({ file: f, langs: [lang] });
      }
    }
  }
  // Shared, language-agnostic resolution files → full gated set via fileLanguages.
  for (const name of SHARED_RESOLUTION_FILES) {
    const f = join(INGESTION_DIR, name);
    if (existsSync(f)) out.push({ file: f, langs: fileLanguages(rel(f)) });
  }
  return out;
}

let _program: ts.Program | null = null;
let _checker: ts.TypeChecker | null = null;
function buildProgram(
  rootFiles: string[],
): { program: ts.Program; checker: ts.TypeChecker } | null {
  if (_program && _checker) return { program: _program, checker: _checker };
  try {
    const cfg = ts.readConfigFile(join(REPO_ROOT, 'tsconfig.json'), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(cfg.config ?? {}, ts.sys, REPO_ROOT);
    const options: ts.CompilerOptions = { ...parsed.options, noEmit: true, skipLibCheck: true };
    _program = ts.createProgram(rootFiles, options);
    _checker = _program.getTypeChecker();
    return { program: _program, checker: _checker };
  } catch {
    return null;
  }
}

/** True when `node`'s resolved type is (or includes) a tree-sitter SyntaxNode. */
function isSyntaxNodeReceiver(checker: ts.TypeChecker, node: ts.Node): boolean {
  try {
    const s = checker.typeToString(checker.getTypeAtLocation(node));
    return /\bSyntaxNode\b/.test(s);
  } catch {
    return false;
  }
}

/** Did the build succeed? (false => mode degraded; surfaced so coverage isn't silently lost) */
export let resolutionLayerProgramOk = true;

function collectResolutionLayerLiterals(): ScanResult {
  const nodeTypes: CollectedNodeType[] = [];
  const fields: CollectedField[] = [];
  const entries = resolutionLayerFiles();
  const built = buildProgram(entries.map((e) => e.file));
  if (!built) {
    resolutionLayerProgramOk = false;
    return { nodeTypes, fields };
  }
  const { program, checker } = built;

  for (const { file, langs } of entries) {
    const sf = program.getSourceFile(file);
    if (!sf) continue;
    const relPath = rel(file);
    const constMembers = new Map<string, string[]>();
    const consumedSets = new Set<string>();

    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const m = collectConstMembers(node.initializer);
        if (m) constMembers.set(node.name.text, m);
      }
      // `<recv>.type === 'lit'` — only when recv is a SyntaxNode
      if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
      ) {
        const { left, right } = node;
        const lit = ts.isStringLiteral(left) ? left : ts.isStringLiteral(right) ? right : null;
        const dot = isDotType(left) ? left : isDotType(right) ? right : null;
        if (lit && dot && isSyntaxNodeReceiver(checker, dot.expression)) {
          nodeTypes.push({
            literal: lit.text,
            languages: langs,
            file: relPath,
            line: lineOf(sf, lit),
            source: 'compare',
          });
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const arg0 = node.arguments[0];
        // childForFieldName('field') on a SyntaxNode
        if (
          FIELD_LOOKUP_NAMES.has(method) &&
          arg0 &&
          ts.isStringLiteral(arg0) &&
          isSyntaxNodeReceiver(checker, node.expression.expression)
        ) {
          fields.push({
            field: arg0.text,
            languages: langs,
            file: relPath,
            line: lineOf(sf, arg0),
            receiverNodeType: receiverNodeTypeOf(node, sf),
          });
        }
        // SET.has(<recv>.type) where recv is a SyntaxNode
        if (
          MEMBERSHIP_NAMES.has(method) &&
          arg0 &&
          isDotType(arg0) &&
          ts.isIdentifier(node.expression.expression) &&
          isSyntaxNodeReceiver(checker, arg0.expression)
        ) {
          consumedSets.add(node.expression.expression.text);
        }
      }
      // findChild/findNamedChild/findSiblingChild(<recv>, 'lit') 2nd arg, or
      // findNodeAtRange(_, _, 'lit') 3rd arg — node-type literals; gate recv.
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const fname = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : '';
        if (NODE_ARG_FNS.has(fname)) {
          const recv = node.arguments[0];
          const a1 = node.arguments[1];
          if (a1 && ts.isStringLiteral(a1) && recv && isSyntaxNodeReceiver(checker, recv)) {
            nodeTypes.push({
              literal: a1.text,
              languages: langs,
              file: relPath,
              line: lineOf(sf, a1),
              source: 'find-node-arg',
            });
          }
        } else if (fname === 'findNodeAtRange') {
          const a2 = node.arguments[2];
          if (a2 && ts.isStringLiteral(a2)) {
            nodeTypes.push({
              literal: a2.text,
              languages: langs,
              file: relPath,
              line: lineOf(sf, a2),
              source: 'find-node-arg',
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    for (const constName of consumedSets) {
      const members = constMembers.get(constName);
      if (!members) continue;
      for (const literal of members) {
        nodeTypes.push({
          literal,
          languages: constNameLanguages(constName, langs),
          file: relPath,
          line: 0,
          source: 'set-member',
        });
      }
    }
  }
  return { nodeTypes, fields };
}

// ---------------------------------------------------------------------------
// Mode 3 — registry scope-query probes
// ---------------------------------------------------------------------------
async function collectRegistryQueryProbes(): Promise<RegistryQueryProbe[]> {
  const out: RegistryQueryProbe[] = [];
  const langsDir = join(INGESTION_DIR, 'languages');
  if (!existsSync(langsDir)) return out;
  for (const dir of readdirSync(langsDir)) {
    if (dir === 'cobol') continue;
    const lang = DIR_LANG[dir];
    if (!lang) continue;
    const queryFile = join(langsDir, dir, 'query.ts');
    if (!existsSync(queryFile)) continue;
    // Importing query.ts loads the grammar at module top level — gate it.
    if (!isLanguageAvailable(lang)) continue;
    let mod: Record<string, unknown>;
    try {
      mod = (await import(queryFile)) as Record<string, unknown>;
    } catch (e) {
      out.push({ language: lang, getter: '(import)', error: String((e as Error).message ?? e) });
      continue;
    }
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== 'function' || !/ScopeQuery$/.test(name)) continue;
      try {
        (value as () => unknown)();
        out.push({ language: lang, getter: name, error: null });
      } catch (e) {
        out.push({ language: lang, getter: name, error: String((e as Error).message ?? e) });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
export interface CollectedLiterals {
  nodeTypes: CollectedNodeType[];
  fields: CollectedField[];
  queryProbes: RegistryQueryProbe[];
}

export async function collectAllLiterals(): Promise<CollectedLiterals> {
  const config = await collectConfigNodeTypes();
  const inCode = collectInCodeLiterals();
  const resolution = collectResolutionLayerLiterals(); // Mode 4 (TypeChecker-gated)
  const queryProbes = await collectRegistryQueryProbes();
  return {
    nodeTypes: [...config, ...inCode.nodeTypes, ...resolution.nodeTypes],
    fields: [...inCode.fields, ...resolution.fields],
    queryProbes,
  };
}

// Exposed for focused unit tests.
export const __test = {
  collectConfigNodeTypes,
  collectInCodeLiterals,
  collectResolutionLayerLiterals,
  resolutionLayerFiles,
  mode2Files,
  fileLanguages,
};
