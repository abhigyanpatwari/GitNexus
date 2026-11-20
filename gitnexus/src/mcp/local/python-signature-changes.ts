import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type Parser from 'tree-sitter';
import {
  lookupLexicalName,
  selectClaimsAtScope,
  SupportedLanguages,
  type ParsedFile,
  type ParsedImport,
  type ImportEdge,
} from 'gitnexus-shared';
import { pythonProvider } from '../../core/ingestion/languages/python.js';
import {
  isPythonImportedModule,
  resolvePythonImportTarget,
} from '../../core/ingestion/languages/python/import-target.js';
import { extractParsedFile } from '../../core/ingestion/scope-extractor-bridge.js';
import { parseSourceSafe } from '../../core/tree-sitter/safe-parse.js';
import { createParserForLanguage } from '../../core/tree-sitter/parser-loader.js';
import { readSafeBounded } from '../../core/group/extractors/fs-utils.js';
import { getGitRoot } from '../../storage/git.js';
import {
  nodeRange,
  rangeKey,
  walkNamedNodes,
} from '../../core/ingestion/languages/rename-tree-sitter.js';

const run = promisify(execFile);
const sourceLimit = 4 * 1024 * 1024;
type Node = Parser.SyntaxNode;
type Target = { id: string; name: string; type: string; filePath: string };
type Caller = { target: string; filePath: string };
type SignatureChange = { target: Target; removed: Set<string>; declaration: string };
export type BrokenKeywordCall = {
  target: string;
  name: string;
  filePath: string;
  line: number;
  keyword: string;
};

function groupBy<T>(values: readonly T[], key: (value: T) => string) {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const id = key(value);
    const group = groups.get(id);
    if (group) group.push(value);
    else groups.set(id, [value]);
  }
  return groups;
}

// Undefined denotes a working-tree image, the empty string denotes the Git index.
async function readImage(cwd: string, rev: string | undefined, file: string) {
  if (rev === undefined) return readSafeBounded(cwd, file, sourceLimit);
  try {
    return (
      await run('git', ['cat-file', 'blob', rev + ':' + file], { cwd, maxBuffer: sourceLimit })
    ).stdout;
  } catch (e) {
    // A new/deleted file has no corresponding image to compare.
    if ((e as { code?: number }).code === 128) return null;
    throw e;
  }
}

async function diffImages(
  cwd: string,
  scope: string,
  base?: string,
): Promise<[string, string | undefined]> {
  if (scope === 'unstaged') return ['', undefined];
  if (scope !== 'compare') return ['HEAD', scope === 'staged' ? '' : undefined];
  if (!base) throw new Error('Missing base revision for Python signature comparison');
  const resolve = async (ref: string) =>
    (
      await run(
        'git',
        ['rev-parse', '--verify', '--end-of-options', (ref || 'HEAD') + '^{commit}'],
        { cwd },
      )
    ).stdout.trim();
  const range = /^(.*?)(\.{2,3})(.*?)$/.exec(base);
  if (!range) return [await resolve(base), undefined];
  const [left, right] = await Promise.all([resolve(range[1]), resolve(range[3])]);
  return [
    range[2] === '...'
      ? (await run('git', ['merge-base', left, right], { cwd })).stdout.trim()
      : left,
    right,
  ];
}

// Decorated definitions may replace the callable. Only compare signatures
// whose keyword contract can be read directly from the Python definition.
function signatures(parser: Parser, source: string) {
  const root = parseSourceSafe(parser, source).rootNode;
  const result = new Map<
    string,
    { keywords: Set<string>; arbitrary: boolean; declaration: string }
  >();
  if (root.hasError) return result;
  for (const def of root.namedChildren) {
    const isClass = def.type === 'class_definition';
    if (!isClass && def.type !== 'function_definition') continue;
    const callable = isClass
      ? def
          .childForFieldName('body')
          ?.namedChildren.find(
            (n) =>
              n.type === 'function_definition' && n.childForFieldName('name')?.text === '__init__',
          )
      : def;
    const params = callable?.childForFieldName('parameters');
    if (!params) {
      // Only infer object.__init__ for a plain class body. Bases, decorators
      // and class-body code can supply a constructor that accepts keywords.
      const body = def.childForFieldName('body');
      const defaultConstructor =
        isClass &&
        !def.childForFieldName('superclasses')?.namedChildCount &&
        body?.namedChildren.every(
          (n) =>
            n.type === 'pass_statement' ||
            n.type === 'comment' ||
            (n.type === 'function_definition' &&
              !['__init__', '__new__'].includes(n.childForFieldName('name')?.text ?? '') &&
              !n.childForFieldName('return_type') &&
              n
                .childForFieldName('parameters')
                ?.namedChildren.every((p) => p.type === 'identifier')) ||
            (n.type === 'expression_statement' && n.firstNamedChild?.type === 'string'),
        );
      if (!defaultConstructor) continue;
    }
    const keywords = new Set<string>();
    let arbitrary = false;
    for (const [i, param] of (params?.namedChildren ?? []).entries()) {
      if (param.type === 'positional_separator') {
        keywords.clear();
        continue;
      }
      const name =
        param.childForFieldName('name') ??
        (param.type === 'identifier' ? param : param.firstNamedChild);
      if (param.type === 'dictionary_splat_pattern' || name?.type === 'dictionary_splat_pattern')
        arbitrary = true;
      if (param.type === 'list_splat_pattern' || param.type === 'dictionary_splat_pattern')
        continue;
      if (name?.type === 'identifier' && (!isClass || i > 0)) keywords.add(name.text);
    }
    const name = def.childForFieldName('name');
    if (!name) continue;
    result.set((isClass ? 'Class:' : 'Function:') + name.text, {
      keywords,
      arbitrary,
      declaration: rangeKey(nodeRange(def)),
    });
  }
  return result;
}

// Module resolution and re-exports must use the same Git image as the call.
async function pythonFiles(cwd: string, revision: string | undefined) {
  const args = revision
    ? ['ls-tree', '-rz', '--name-only', revision]
    : [
        'ls-files',
        '-z',
        '--cached',
        ...(revision === undefined ? ['--others', '--exclude-standard'] : []),
        '--',
        '*.py',
      ];
  const { stdout } = await run('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return new Set(stdout.split('\0').filter((file) => file.endsWith('.py')));
}

function sourceBindings(parsed: ParsedFile) {
  const scopes = new Map(parsed.scopes.map((scope) => [scope.id, scope]));
  const sites = new Map(
    parsed.referenceSites
      .filter((site) => site.kind === 'call')
      .map((site) => [rangeKey(site.atRange), site.lookupScope ?? site.inScope]),
  );
  const imports = new Map<ImportEdge, ParsedImport>();
  const byScope = new Map<string, ImportEdge[]>();
  for (const imp of parsed.parsedImports) {
    if (imp.kind !== 'named' && imp.kind !== 'alias' && imp.kind !== 'namespace') continue;
    const edge: ImportEdge = {
      localName: imp.localName,
      kind: imp.kind,
      targetFile: null,
      targetExportedName: imp.importedName,
      atRange: imp.atRange,
      linkStatus: 'unresolved',
    };
    const owner = imp.declaredAtScope ?? parsed.moduleScope;
    const bucket = byScope.get(owner);
    if (bucket) bucket.push(edge);
    else byScope.set(owner, [edge]);
    imports.set(edge, imp);
  }
  const sources = {
    scopes: { getScope: (id: string) => scopes.get(id) },
    importsAt: (owner: ParsedFile['scopes'][number]) => byScope.get(owner.id) ?? [],
  };
  return (call: Node, head: string) => {
    const position = nodeRange(call);
    const anchor = sites.get(rangeKey(position));
    if (!anchor) return;
    const selected = lookupLexicalName(anchor, head, sources, { position, purpose: 'value' });
    if (selected.imports.length) {
      return selected.imports.flatMap((edge) => {
        const imp = imports.get(edge);
        return imp ? [imp] : [];
      });
    }
    if (
      selected.scope?.id === parsed.moduleScope &&
      selected.bindings.length === 1 &&
      selected.bindings[0].origin === 'local'
    )
      return 'local';
  };
}

// Walk explicit named imports only. The cycle guard is also needed for
// "from . import X", whose base is the importing package itself.
function exportResolver(
  changes: Iterable<SignatureChange>,
  allFilePaths: Set<string>,
  loadFile: (file: string) => Promise<ParsedFile | null>,
) {
  const definitions = new Map<string, SignatureChange | null>();
  for (const change of changes) {
    const key = change.target.filePath + '\0' + change.target.name;
    definitions.set(key, definitions.has(key) ? null : change);
  }
  const cache = new Map<string, SignatureChange | null>();
  return async (moduleFile: string, name: string) => {
    const seen = new Set<string>();
    let file: string | null = moduleFile;
    let result: SignatureChange | null = null;
    while (file) {
      const key: string = file + '\0' + name;
      const cached = cache.get(key);
      if (cached !== undefined) {
        result = cached;
        break;
      }
      if (seen.has(key)) break;
      seen.add(key);
      const parsed = await loadFile(file);
      const scope = parsed?.scopes.find((s) => s.id === parsed.moduleScope);
      if (!parsed || !scope) break;
      const selected = selectClaimsAtScope(scope, name);
      if (selected.status !== 'selected' || selected.claims.length !== 1) break;
      const claim = rangeKey(selected.claims[0].range);
      if (selected.claims[0].kind === 'binding') {
        const definition = definitions.get(key);
        if (definition?.declaration === claim) result = definition;
        break;
      }
      if (selected.claims[0].kind !== 'import') break;
      const imp = parsed.parsedImports.find(
        (i) =>
          'localName' in i &&
          i.localName === name &&
          i.declaredAtScope === scope.id &&
          i.atRange &&
          rangeKey(i.atRange) === claim,
      );
      if (!imp || (imp.kind !== 'alias' && imp.kind !== 'named') || !imp.reexportsName) break;
      file = resolvePythonImportTarget(
        { ...imp, targetIncludesImportedName: true },
        { fromFile: file, allFilePaths },
      );
      name = imp.importedName;
    }
    for (const key of seen) cache.set(key, result);
    return result;
  };
}

function importedCallee(
  imp: ParsedImport,
  spelling: string,
  fromFile: string,
  allFilePaths: Set<string>,
) {
  const ctx = { fromFile, allFilePaths };
  if (imp.kind === 'named' || imp.kind === 'alias') {
    if (spelling === imp.localName) {
      return {
        file: resolvePythonImportTarget({ ...imp, targetIncludesImportedName: true }, ctx),
        name: imp.importedName,
      };
    }
    const file = resolvePythonImportTarget(imp, ctx);
    if (
      file &&
      isPythonImportedModule(imp, file, fromFile) &&
      spelling.startsWith(imp.localName + '.')
    )
      return { file, name: spelling.slice(imp.localName.length + 1) };
  }
  if (imp.kind === 'namespace') {
    const prefix = (imp.explicitAlias ? imp.localName : imp.targetRaw) + '.';
    if (spelling.startsWith(prefix))
      return { file: resolvePythonImportTarget(imp, ctx), name: spelling.slice(prefix.length) };
  }
}

export async function findBrokenKeywordCalls(
  directory: string,
  scope: string,
  base: string | undefined,
  targets: Target[],
  incoming: (ids: string[]) => Promise<Caller[]>,
): Promise<BrokenKeywordCall[]> {
  const cwd = getGitRoot(directory) ?? directory;
  const [before, after] = await diffImages(cwd, scope, base);
  const parser = await createParserForLanguage(SupportedLanguages.Python);
  const changed = new Map<string, SignatureChange>();
  const definitions = groupBy(targets, (t) => t.filePath);
  for (const [file, symbols] of definitions) {
    const [oldText, newText] = await Promise.all([
      readImage(cwd, before, file),
      readImage(cwd, after, file),
    ]);
    if (!oldText || !newText) continue;
    const oldDefs = signatures(parser, oldText);
    const newDefs = signatures(parser, newText);
    for (const target of symbols) {
      const key = target.type + ':' + target.name;
      const prev = oldDefs.get(key);
      const next = newDefs.get(key);
      if (!prev || !next || next.arbitrary) continue;
      const removed = new Set([...prev.keywords].filter((name) => !next.keywords.has(name)));
      if (removed.size) changed.set(target.id, { target, removed, declaration: next.declaration });
    }
  }
  if (!changed.size) return [];
  const rows = await incoming([...changed.keys()]);
  if (!rows.length) return [];
  const allFilePaths = await pythonFiles(cwd, after);
  const exports = new Map<string, ParsedFile | null>();
  const resolveExport = exportResolver(changed.values(), allFilePaths, async (file) => {
    const cached = exports.get(file);
    if (cached !== undefined) return cached;
    const source = await readImage(cwd, after, file);
    const tree = source ? parseSourceSafe(parser, source, undefined, undefined, file) : null;
    const parsed =
      source && tree && !tree.rootNode.hasError
        ? extractParsedFile(pythonProvider, source, file, undefined, tree)
        : null;
    exports.set(file, parsed);
    return parsed;
  });
  const findings: BrokenKeywordCall[] = [];
  for (const [file, callers] of groupBy(rows, (r) => r.filePath)) {
    const text = await readImage(cwd, after, file);
    if (!text) continue;
    const tree = parseSourceSafe(parser, text, undefined, undefined, file);
    const root = tree.rootNode;
    if (root.hasError) continue;
    const targetsInFile = new Set(callers.map((caller) => caller.target));
    const keywords = new Set(
      [...targetsInFile].flatMap((id) => [...(changed.get(id)?.removed ?? [])]),
    );
    const parsed = extractParsedFile(pythonProvider, text, file, undefined, tree);
    if (!parsed) continue;
    const bindings = sourceBindings(parsed);
    for (const call of walkNamedNodes(root)) {
      if (call.type !== 'call') continue;
      const explicit = (call.childForFieldName('arguments')?.namedChildren ?? []).flatMap((arg) => {
        const keyword = arg.type === 'keyword_argument' && arg.childForFieldName('name')?.text;
        return keyword && keywords.has(keyword) ? [keyword] : [];
      });
      if (!explicit.length) continue;
      const spelling = call.childForFieldName('function')?.text ?? '';
      const claims = bindings(call, spelling.split('.', 1)[0]);
      if (!claims) continue;
      const candidates = new Set<SignatureChange>();
      if (claims === 'local') {
        const local = await resolveExport(file, spelling);
        if (local) candidates.add(local);
      } else {
        for (const imp of claims) {
          const imported = importedCallee(imp, spelling, file, allFilePaths);
          if (!imported?.file || imported.name.includes('.')) continue;
          const candidate = await resolveExport(imported.file, imported.name);
          if (candidate) candidates.add(candidate);
        }
      }
      if (candidates.size !== 1) continue;
      const [change] = candidates;
      if (!targetsInFile.has(change.target.id)) continue;
      const { target, removed } = change;
      for (const keyword of explicit) {
        if (removed.has(keyword))
          findings.push({
            target: target.id,
            name: target.name,
            filePath: file,
            line: call.startPosition.row + 1,
            keyword,
          });
      }
    }
  }
  return findings.sort(
    (a, b) =>
      a.filePath.localeCompare(b.filePath) || a.line - b.line || a.keyword.localeCompare(b.keyword),
  );
}
