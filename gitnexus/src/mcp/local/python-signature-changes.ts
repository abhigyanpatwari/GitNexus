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
  pythonNamespaceReceiverPaths,
  resolvePythonImportTarget,
} from '../../core/ingestion/languages/python/import-target.js';
import { extractParsedFile } from '../../core/ingestion/scope-extractor-bridge.js';
import { ParseTimeoutError, parseSourceSafe } from '../../core/tree-sitter/safe-parse.js';
import { createParserForLanguage } from '../../core/tree-sitter/parser-loader.js';
import { callerImages, pythonFiles, readImage, type Image } from './python-signature-images.js';
import { getGitRoot } from '../../storage/git.js';
import { nodeRange, rangeKey } from '../../core/ingestion/languages/rename-tree-sitter.js';

const run = promisify(execFile);
const smallScopeTree = 12_000;
type Node = Parser.SyntaxNode;
type Target = { id: string; name: string; type: string; filePath: string };
type Caller = {
  target: string;
  filePath: string;
  unverified?: 'inherited-constructor' | 'super-initializer';
};
type SignatureChange = {
  target: Target;
  removed: Set<string>;
  // When **kwargs is removed, every explicit name outside this set breaks.
  stillAccepted?: Set<string>;
  declaration: string;
  moduleLevel: boolean;
};
type ChangedFile = { filePath: string; oldFilePath?: string };
export type BrokenKeywordCall = {
  target: string;
  name: string;
  filePath: string;
  line: number;
  keyword: string;
  keywords?: string[];
};

export interface KeywordCheck {
  findings: BrokenKeywordCall[];
  complete: boolean;
  skipped: { filePath: string; reason: string }[];
}

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
        { cwd, timeout: 15_000 },
      )
    ).stdout.trim();
  const range = /^(.*?)(\.{2,3})(.*?)$/.exec(base);
  if (!range) return [await resolve(base), undefined];
  const [left, right] = await Promise.all([resolve(range[1]), resolve(range[3])]);
  return [
    range[2] === '...'
      ? (await run('git', ['merge-base', left, right], { cwd, timeout: 15_000 })).stdout.trim()
      : left,
    right,
  ];
}

// Decorated definitions may replace the callable. Only compare signatures
// whose keyword contract can be read directly from the Python definition.
type Signature = {
  moduleLevel: boolean;
  keywords: Set<string>;
  arbitrary: boolean;
  receiver?: string;
  declaration: string;
  decoratedHeader?: string;
};

function signatures(root: Node, names: Set<string>) {
  const result = new Map<string, Signature | null>();
  const definitions = root.descendantsOfType(['class_definition', 'function_definition']);
  for (const def of definitions) {
    const name = def.childForFieldName('name')?.text;
    if (!name || !names.has(name)) continue;
    const isClass = def.type === 'class_definition';
    const parents = [];
    for (let p = def.parent; p; p = p.parent) {
      if (p.type === 'class_definition' || p.type === 'function_definition') {
        const parentName = p.childForFieldName('name')?.text;
        if (parentName) parents.unshift(parentName);
      }
    }
    const key = (isClass ? 'Class:' : 'Function:') + [...parents, name].join('.');
    const duplicate = result.has(key);
    // Keep unsupported declarations distinguishable from a genuinely new or
    // deleted callable. Conditional same-name declarations remain ambiguous.
    result.set(key, null);
    if (duplicate) continue;
    const decorated = def.parent?.type === 'decorated_definition' ? def.parent : undefined;
    if (isClass && decorated) continue;
    const bases = def.childForFieldName('superclasses');
    if (
      isClass &&
      bases?.namedChildren.some((n) => n.type === 'keyword_argument' || n.type.includes('splat'))
    )
      continue;
    const members = isClass ? def.childForFieldName('body')?.namedChildren : undefined;
    // In Python the final class-body binding wins. A decorated initializer or
    // custom allocator can change keyword handling beyond the signature.
    const initializer = members
      ?.filter((member) => {
        const inner =
          member.type === 'decorated_definition' ? member.childForFieldName('definition') : member;
        return inner?.childForFieldName('name')?.text === '__init__';
      })
      .at(-1);
    if (initializer && initializer.type !== 'function_definition') continue;
    if (
      members?.some(
        (member) =>
          (member.type === 'decorated_definition'
            ? member.childForFieldName('definition')
            : member
          )?.childForFieldName('name')?.text === '__new__',
      )
    )
      continue;
    const callable = isClass ? initializer : def;
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
    let receiver: string | undefined;
    for (const [i, param] of (params?.namedChildren ?? []).entries()) {
      if (param.type === 'positional_separator') {
        keywords.clear();
        receiver = undefined;
        continue;
      }
      const name =
        param.childForFieldName('name') ??
        (param.type === 'identifier' ? param : param.firstNamedChild);
      if (param.type === 'dictionary_splat_pattern' || name?.type === 'dictionary_splat_pattern')
        arbitrary = true;
      if (param.type === 'list_splat_pattern' || param.type === 'dictionary_splat_pattern')
        continue;
      if (name?.type === 'identifier') {
        if (isClass && i === 0) receiver = name.text;
        else keywords.add(name.text);
      }
    }
    result.set(key, {
      moduleLevel: parents.length === 0,
      keywords,
      arbitrary,
      receiver,
      declaration: rangeKey(nodeRange(def)),
      // A body-only edit has no new static signature to compare. If the
      // decorators or header moved semantically, the wrapper contract is unknown.
      ...(decorated && {
        decoratedHeader: JSON.stringify([
          ...decorated.namedChildren
            .filter((node) => node.type === 'decorator')
            .map((node) => node.text),
          def.childForFieldName('type_parameters')?.text,
          params?.text,
          def.childForFieldName('return_type')?.text,
        ]),
      }),
    });
  }
  return result;
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
    if (selected.bindings.length === 1 && selected.bindings[0].origin === 'local') {
      const binding = selected.bindings[0];
      const range = binding.declarationRange ?? binding.def.declarationRange;
      if (range) return { declaration: rangeKey(range) };
    }
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
    if (!change.moduleLevel) continue;
    const key = change.target.filePath + '\0' + change.target.name;
    definitions.set(key, definitions.has(key) ? null : change);
  }
  const cache = new Map<string, SignatureChange | null>();
  const importIndexes = new WeakMap<ParsedFile, Map<string, ParsedImport>>();
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
      let imports = importIndexes.get(parsed);
      if (!imports) {
        imports = new Map();
        for (const imp of parsed.parsedImports) {
          if ('localName' in imp && imp.atRange && imp.declaredAtScope === scope.id)
            imports.set(imp.localName + '\0' + rangeKey(imp.atRange), imp);
        }
        importIndexes.set(parsed, imports);
      }
      const imp = imports.get(name + '\0' + claim);
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
    const file = resolvePythonImportTarget(imp, ctx);
    if (!file) return;
    if (spelling.startsWith(prefix)) return { file, name: spelling.slice(prefix.length) };
    if (imp.targetRaw) {
      const paths = pythonNamespaceReceiverPaths(
        {
          localName: imp.localName,
          importPath: imp.targetRaw,
          targetFile: file,
          explicitAlias: imp.explicitAlias,
        },
        (p) => allFilePaths.has(p),
      );
      const split = spelling.lastIndexOf('.');
      const path = paths?.find(([receiver]) => receiver === spelling.slice(0, split));
      if (path) return { file: path[1], name: spelling.slice(split + 1) };
    }
  }
}

// Scope extraction grows superlinearly for thousands of bindings in one
// scope. Large functions made up mostly of expressions can still be cheap.
function tooDenseForScopeExtraction(root: Node): boolean {
  if (root.descendantCount <= smallScopeTree) return false;
  if (root.descendantCount > 64_000) return true;
  const weights = new Map<number, number>();
  const bindingSites = root.descendantsOfType([
    'assignment',
    'augmented_assignment',
    'named_expression',
    'for_statement',
    'for_in_clause',
    'as_pattern',
    'parameters',
    'import_statement',
    'import_from_statement',
    'function_definition',
    'class_definition',
  ]);
  for (const site of bindingSites) {
    let owner = site.parent;
    while (
      owner &&
      owner.type !== 'module' &&
      owner.type !== 'function_definition' &&
      owner.type !== 'class_definition' &&
      owner.type !== 'lambda'
    )
      owner = owner.parent;
    const id = owner?.id ?? root.id;
    const target = site.childForFieldName('left') ?? site.childForFieldName('name');
    const weight = target?.descendantCount ?? Math.max(1, site.namedChildCount);
    const total = (weights.get(id) ?? 0) + weight;
    if (total > 1_500) return true;
    weights.set(id, total);
  }
  return false;
}

export async function findBrokenKeywordCalls(
  directory: string,
  scope: string,
  base: string | undefined,
  targets: Target[],
  incoming: (ids: string[]) => Promise<Caller[]>,
  changedFiles: readonly ChangedFile[] = [],
): Promise<KeywordCheck> {
  const cwd = getGitRoot(directory) ?? directory;
  const [before, after] = await diffImages(cwd, scope, base);
  const parser = await createParserForLanguage(SupportedLanguages.Python);
  const skipped = new Map<string, Set<string>>();
  const skip = (file: string, reason: string) => {
    const reasons = skipped.get(file) ?? new Set<string>();
    reasons.add(reason);
    skipped.set(file, reasons);
  };
  const findings: BrokenKeywordCall[] = [];
  const result = (): KeywordCheck => ({
    findings: findings.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line),
    complete: skipped.size === 0,
    skipped: [...skipped].map(([filePath, reasons]) => ({
      filePath,
      reason: [...reasons].join('; '),
    })),
  });
  const parse = (file: string, source: Image) => {
    if (source === undefined) skip(file, 'Source unreadable or exceeds the 4 MiB file limit');
    if (!source) return;
    let tree: Parser.Tree;
    try {
      tree = parseSourceSafe(parser, source, undefined, undefined, file);
    } catch (error) {
      if (!(error instanceof ParseTimeoutError)) throw error;
      skip(file, 'Python parse timed out');
      return;
    }
    if (tree.rootNode.hasError) {
      skip(file, 'Python syntax error');
      return;
    }
    return tree;
  };

  const changed = new Map<string, SignatureChange>();
  const newPaths = new Map(
    changedFiles.flatMap((f) => (f.oldFilePath ? [[f.oldFilePath, f.filePath] as const] : [])),
  );
  const oldPaths = new Map(changedFiles.map((f) => [f.filePath, f.oldFilePath ?? f.filePath]));
  const definitions = groupBy(targets, (t) => newPaths.get(t.filePath) ?? t.filePath);
  for (const [file, symbols] of definitions) {
    const [oldText, newText] = await Promise.all([
      readImage(cwd, before, oldPaths.get(file) ?? file),
      readImage(cwd, after, file),
    ]);
    // No old contract for a new file, and no live calls into a deleted file.
    if (oldText === null || newText === null || (oldText !== undefined && oldText === newText))
      continue;
    const oldTree = parse(file, oldText);
    const newTree = parse(file, newText);
    if (!oldTree || !newTree) continue;
    const names = new Set(symbols.map((t) => t.name));
    const oldDefs = signatures(oldTree.rootNode, names);
    const newDefs = signatures(newTree.rootNode, names);
    const qualifiedKeys = new Set([...oldDefs.keys(), ...newDefs.keys()]);
    const byName = groupBy([...qualifiedKeys], (key) => {
      const [kind, name] = key.split(':');
      return kind + ':' + name.split('.').at(-1);
    });
    const symbolGroups = groupBy(symbols, (s) => s.type + ':' + s.name);
    for (const symbol of symbols) {
      const simple = symbol.type + ':' + symbol.name;
      // Python local declarations carry their owning scope and a position
      // suffix in graph IDs (run.save@4:4). Lines alone cannot identify the
      // same callable across two independently edited source images.
      const prefix = [symbol.filePath, file, oldPaths.get(file)]
        .map((path) => symbol.type + ':' + path + ':')
        .find((prefix) => symbol.id.startsWith(prefix));
      const qualified = prefix && symbol.id.slice(prefix.length).replace(/@\d+:\d+/g, '');
      const options = byName.get(simple) ?? [];
      const id =
        qualified?.split('.').at(-1) === symbol.name
          ? symbol.type + ':' + qualified
          : options.length === 1 && symbolGroups.get(simple)?.length === 1
            ? options[0]
            : undefined;
      if (!id && options.length === 0) continue;
      if (id && (!oldDefs.has(id) || !newDefs.has(id))) continue;
      const prev = id && oldDefs.get(id);
      const next = id && newDefs.get(id);
      if (!prev || !next) {
        skip(file, 'Signature unavailable or ambiguous for ' + symbol.name);
        continue;
      }
      if (prev.decoratedHeader !== undefined || next.decoratedHeader !== undefined) {
        if (prev.decoratedHeader !== next.decoratedHeader)
          skip(file, 'Decorated callable signature cannot be verified for ' + symbol.name);
        continue;
      }
      if (next.arbitrary) continue;
      const removed = new Set([...prev.keywords].filter((name) => !next.keywords.has(name)));
      if (removed.size || prev.arbitrary) {
        // Passing the bound receiver by keyword was already invalid, even
        // with **kwargs (unless it was positional-only).
        const stillAccepted = prev.arbitrary ? new Set(next.keywords) : undefined;
        if (prev.receiver) stillAccepted?.add(prev.receiver);
        changed.set(symbol.id, {
          target: { ...symbol, filePath: file },
          removed,
          stillAccepted,
          declaration: next.declaration,
          moduleLevel: next.moduleLevel,
        });
      }
    }
  }
  if (!changed.size) return result();
  const rows = await incoming([...changed.keys()]);
  const graphFiles = groupBy(
    rows.filter((r) => r.filePath.endsWith('.py')),
    (r) => newPaths.get(r.filePath) ?? r.filePath,
  );
  const diffPaths = new Set(
    changedFiles.map((f) => f.filePath).filter((file) => file.endsWith('.py')),
  );
  const files = [...new Set([...diffPaths].sort().concat([...graphFiles.keys()].sort()))];
  if (!files.length) return result();
  const allKeywords = new Set([...changed.values()].flatMap((c) => [...c.removed]));
  const anyVariadicRemoved = [...changed.values()].some((c) => c.stillAccepted !== undefined);
  const localDefs = new Map(
    [...changed.values()].map((c) => [c.target.filePath + '\0' + c.declaration, c]),
  );
  let paths: Set<string> | null | undefined;
  let resolveExport: ReturnType<typeof exportResolver> | undefined;
  const exports = new Map<string, ParsedFile | null>();
  // Scope extraction can grow superlinearly in densely bound generated code.
  // Bound both a single synchronous extraction and the total work per request.
  let extractions = 0;
  let remainingNodes = 8 * smallScopeTree;
  const extract = (file: string, source: string, tree: Parser.Tree) => {
    const nodes = tree.rootNode.descendantCount;
    if (nodes > remainingNodes || extractions >= 256 || tooDenseForScopeExtraction(tree.rootNode)) {
      skip(file, 'Python scope extraction budget exceeded');
      return null;
    }
    extractions++;
    remainingNodes -= nodes;
    const parsed = extractParsedFile(pythonProvider, source, file, undefined, tree);
    if (!parsed) skip(file, 'Python scope extraction failed');
    return parsed ?? null;
  };
  const loadExport = async (file: string) => {
    const cached = exports.get(file);
    if (cached !== undefined) return cached;
    const source = await readImage(cwd, after, file);
    const tree = parse(file, source);
    let parsed = source && tree ? extract(file, source, tree) : null;
    if (source === null) skip(file, 'Imported module is missing from the source image');
    if (parsed?.parsedImports.some((imp) => imp.kind === 'wildcard')) {
      skip(file, 'Wildcard import may change the exported binding');
      parsed = null;
    }
    exports.set(file, parsed);
    return parsed;
  };
  const maxFiles = 4096;
  if (files.length > maxFiles)
    skip(files[maxFiles], `Caller scan limit reached; ${files.length - maxFiles} files omitted`);
  let callerBytes = 0;
  for await (const [file, text] of callerImages(cwd, after, files.slice(0, maxFiles))) {
    if (text === undefined) {
      skip(file, 'Source unreadable or exceeds the 4 MiB file limit');
      continue;
    }
    if (!text) continue;
    const graphCallers = graphFiles.get(file) ?? [];
    if (graphCallers.some((c) => c.unverified)) {
      skip(
        file,
        'Subclass constructor or super().__init__ forwarding may depend on the changed signature',
      );
    }
    callerBytes += Buffer.byteLength(text);
    if (callerBytes > 64 * 1024 * 1024) {
      skip(file, 'Caller scan reached the 64 MiB total source limit');
      break;
    }
    const graphTargets = diffPaths.has(file)
      ? undefined
      : new Set(graphCallers.filter((c) => !c.unverified).map((c) => c.target));
    const keywords = graphTargets
      ? new Set([...graphTargets].flatMap((id) => [...(changed.get(id)?.removed ?? [])]))
      : allKeywords;
    const variadicRemoved = graphTargets
      ? [...graphTargets].some((id) => changed.get(id)?.stillAccepted !== undefined)
      : anyVariadicRemoved;
    // A substring rejection cannot drop a multiline or escaped keyword argument.
    if (
      variadicRemoved
        ? !text.includes('=') && !text.includes('**')
        : keywords.size <= 24 && ![...keywords].some((k) => text.includes(k))
    )
      continue;
    const tree = parse(file, text);
    if (!tree) continue;
    const calls = [];
    for (const call of tree.rootNode.descendantsOfType('call')) {
      const args = call.childForFieldName('arguments')?.namedChildren ?? [];
      const explicit = args.flatMap((arg) => {
        const keyword = arg.type === 'keyword_argument' && arg.childForFieldName('name')?.text;
        return keyword && (variadicRemoved || keywords.has(keyword)) ? [keyword] : [];
      });
      const unpacked = variadicRemoved && args.some((arg) => arg.type === 'dictionary_splat');
      if (explicit.length || unpacked) calls.push({ call, explicit, unpacked });
    }
    if (!calls.length) continue;
    const parsed = extract(file, text, tree);
    if (!parsed) continue;
    const bindings = sourceBindings(parsed);
    const hasWildcard = parsed.parsedImports.some((i) => i.kind === 'wildcard');
    for (const { call, explicit, unpacked } of calls) {
      const spelling = call.childForFieldName('function')?.text ?? '';
      // A star import can replace an otherwise exact lexical binding. Its
      // runtime __all__ is not proven from the current pair of source images.
      if (hasWildcard) {
        skip(file, 'Wildcard import may change the call binding');
        continue;
      }
      const claims = bindings(call, spelling.split('.', 1)[0]);
      if (!claims) continue;
      const candidates = new Set<SignatureChange>();
      if ('declaration' in claims) {
        const local = !spelling.includes('.') && localDefs.get(file + '\0' + claims.declaration);
        if (local) candidates.add(local);
      } else {
        if (paths === undefined) paths = await pythonFiles(cwd, after);
        if (!paths) {
          skip(file, 'Python module inventory unavailable or exceeds the path limit');
          continue;
        }
        resolveExport ??= exportResolver(changed.values(), paths, loadExport);
        for (const imp of claims) {
          const imported = importedCallee(imp, spelling, file, paths);
          if (!imported?.file || imported.name.includes('.')) continue;
          const candidate = await resolveExport(imported.file, imported.name);
          if (candidate) candidates.add(candidate);
        }
      }
      if (candidates.size !== 1) continue;
      const [change] = candidates;
      if (graphTargets && !graphTargets.has(change.target.id)) continue;
      if (unpacked && change.stillAccepted)
        skip(file, 'Cannot verify keys supplied by ** at a call to ' + change.target.name);
      const removed = explicit.filter((keyword) =>
        change.stillAccepted ? !change.stillAccepted.has(keyword) : change.removed.has(keyword),
      );
      if (removed.length)
        findings.push({
          target: change.target.id,
          name: change.target.name,
          filePath: file,
          line: call.startPosition.row + 1,
          keyword: removed[0],
          ...(removed.length > 1 ? { keywords: removed } : {}),
        });
    }
  }
  return result();
}
