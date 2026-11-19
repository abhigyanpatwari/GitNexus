import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type Parser from 'tree-sitter';
import { nameClaimsFor, SupportedLanguages, type ParsedFile } from 'gitnexus-shared';
import { pythonProvider } from '../../core/ingestion/languages/python.js';
import { extractParsedFile } from '../../core/ingestion/scope-extractor-bridge.js';
import { parseSourceSafe } from '../../core/tree-sitter/safe-parse.js';
import { createParserForLanguage } from '../../core/tree-sitter/parser-loader.js';
import { readSafeBounded } from '../../core/group/extractors/fs-utils.js';
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
type SignatureChange = { target: Target; removed: Set<string> };
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
  const result = new Map<string, { keywords: Set<string>; arbitrary: boolean }>();
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
    if (!params) continue;
    const keywords = new Set<string>();
    let arbitrary = false;
    for (const [i, param] of params.namedChildren.entries()) {
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
    });
  }
  return result;
}

function modulePath(module: string, callerFile: string) {
  const relative = module.match(/^\.+/)?.[0].length ?? 0;
  const tail = module.slice(relative).replaceAll('.', '/');
  if (!relative) return tail;
  return path.posix.join(path.posix.dirname(callerFile), ...Array(relative - 1).fill('..'), tail);
}

// An aggregated CALLS edge names the containing function, not the expression.
// Recover import spellings before assigning a keyword to a particular call.
function calleeSpellings(root: Node, callerFile: string, target: Target): Set<string> {
  const names = new Set<string>(callerFile === target.filePath ? [target.name] : []);
  const targetModule = target.filePath.replace(/\.py$/, '').replace(/\/__init__$/, '');
  const matches = (module: string) => {
    const p = modulePath(module, callerFile);
    return (
      !!p && (targetModule === p || (!module.startsWith('.') && targetModule.endsWith('/' + p)))
    );
  };
  for (const statement of root.namedChildren) {
    if (statement.type !== 'import_statement' && statement.type !== 'import_from_statement')
      continue;
    const from = statement.childForFieldName('module_name')?.text;
    for (const imported of statement.childrenForFieldName('name')) {
      const original = imported.childForFieldName('name')?.text ?? imported.text;
      const alias = imported.childForFieldName('alias')?.text ?? original;
      if (from && matches(from) && original === target.name) names.add(alias);
      const module = from ? from + (from.endsWith('.') ? '' : '.') + original : original;
      if (matches(module)) names.add(alias + '.' + target.name);
    }
  }
  return names;
}

// A CALLS edge covers the whole caller. Check the lexical binding of each
// expression in the requested Git image so a nested parameter or a rebound
// import with the same spelling cannot inherit the outer call's diagnosis.
function moduleBindingAtCall(parsed: ParsedFile) {
  const scopes = new Map(parsed.scopes.map((scope) => [scope.id, scope]));
  const sites = new Map(
    parsed.referenceSites
      .filter((site) => site.kind === 'call')
      .map((site) => [rangeKey(site.atRange), site.lookupScope ?? site.inScope]),
  );
  return (node: Node, spelling: string): boolean => {
    const head = spelling.split('.', 1)[0];
    const scopeId = sites.get(rangeKey(nodeRange(node)));
    let scope = scopeId ? scopes.get(scopeId) : undefined;
    while (scope) {
      const claims = nameClaimsFor(scope, head);
      if (scope.id === parsed.moduleScope)
        return claims.length === 1 && claims[0]?.kind !== 'blocked';
      if (claims.length) return false;
      scope = scope.parent ? scopes.get(scope.parent) : undefined;
    }
    return false;
  };
}

export async function findBrokenKeywordCalls(
  cwd: string,
  scope: string,
  base: string | undefined,
  targets: Target[],
  incoming: (ids: string[]) => Promise<Caller[]>,
): Promise<BrokenKeywordCall[]> {
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
      if (removed.size) changed.set(target.id, { target, removed });
    }
  }
  if (!changed.size) return [];
  const rows = await incoming([...changed.keys()]);
  const findings: BrokenKeywordCall[] = [];
  for (const [file, callers] of groupBy(rows, (r) => r.filePath)) {
    const text = await readImage(cwd, after, file);
    if (!text) continue;
    const tree = parseSourceSafe(parser, text, undefined, undefined, file);
    const root = tree.rootNode;
    if (root.hasError) continue;
    // Parse and visit each caller file once, even if it calls multiple changed definitions.
    const byName = new Map<string, SignatureChange | null>();
    for (const id of new Set(callers.map((caller) => caller.target))) {
      const change = changed.get(id);
      if (!change) continue;
      for (const name of calleeSpellings(root, file, change.target)) {
        byName.set(name, byName.has(name) ? null : change);
      }
    }
    if (!byName.size) continue;
    const parsed = extractParsedFile(pythonProvider, text, file, undefined, tree);
    if (!parsed) continue;
    const hasModuleBinding = moduleBindingAtCall(parsed);
    for (const call of walkNamedNodes(root)) {
      if (call.type !== 'call') continue;
      const spelling = call.childForFieldName('function')?.text ?? '';
      const change = byName.get(spelling);
      if (!change || !hasModuleBinding(call, spelling)) continue;
      const { target, removed } = change;
      for (const arg of call.childForFieldName('arguments')?.namedChildren ?? []) {
        const keyword = arg.type === 'keyword_argument' && arg.childForFieldName('name')?.text;
        if (keyword && removed.has(keyword))
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
