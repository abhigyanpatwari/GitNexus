import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type Parser from 'tree-sitter';
import {
  isNotebookFilename,
  lookupLexicalName,
  selectClaimsAtScope,
  SupportedLanguages,
  type ParsedFile,
  type ParsedImport,
  type ImportEdge,
} from 'gitnexus-shared';
import type { LanguageProvider } from '../../language-provider.js';
import type {
  BrokenKeywordCall,
  CallCompatibilityLookup,
  CallCompatibilityTarget,
  CallCompatibilityFile,
  CallCompatibilityResult,
} from '../../call-compatibility.js';
import {
  isPythonImportedModule,
  pythonNamespaceReceiverPaths,
  resolvePythonImportTarget,
} from './import-target.js';
import { extractParsedFile } from '../../scope-extractor-bridge.js';
import { ParseTimeoutError, parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { createParserForLanguage } from '../../../tree-sitter/parser-loader.js';
import {
  callerImages,
  definitionImages,
  pythonFiles,
  readImage,
  type Image,
  type PythonModuleFiles,
} from './signature-images.js';
import { getGitRoot } from '../../../../storage/git.js';
import { isPythonSourceFile } from './query-provider.js';
import { pythonValueBindingsInScope } from './builtin-descriptors.js';
import { compareCodeUnits } from '../../../../lib/utils.js';
import { nodeRange, rangeKey } from '../rename-tree-sitter.js';

const run = promisify(execFile);
const smallScopeTree = 12_000;
type Node = Parser.SyntaxNode;
type SignatureChange = {
  target: CallCompatibilityTarget;
  removed: Set<string>;
  // When **kwargs is removed, every explicit name outside this set breaks.
  stillAccepted?: Set<string>;
  declaration: string;
  moduleLevel: boolean;
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
    const body = isClass ? def.childForFieldName('body') : null;
    let initializer: Node | null | undefined;
    if (body) {
      // Only a final, unconditional method definition proves the class's keyword contract.
      const classSource = body.text;
      if (classSource.includes('__new__') && pythonValueBindingsInScope(def, '__new__').length)
        continue;
      if (classSource.includes('__init__')) {
        initializer = pythonValueBindingsInScope(def, '__init__').at(-1)?.parent;
        if (
          initializer &&
          (initializer.type !== 'function_definition' || initializer.parent?.id !== body.id)
        )
          continue;
      }
    }
    const callable = isClass ? initializer : def;
    const params = callable?.childForFieldName('parameters');
    if (!params) {
      // Only infer object.__init__ for a plain class body. Bases, decorators
      // and class-body code can supply a constructor that accepts keywords.
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
  files: PythonModuleFiles,
  loadFile: (file: string) => Promise<ParsedFile | null>,
  skip: (file: string, reason: string) => void,
) {
  const definitions = new Map<string, SignatureChange | null>();
  for (const change of changes) {
    if (!change.moduleLevel) continue;
    const key = change.target.filePath + '\0' + change.target.name;
    definitions.set(key, definitions.has(key) ? null : change);
  }
  type ResolvedExport = { change: SignatureChange; needsIndexedCall: boolean };
  const cache = new Map<string, ResolvedExport | null>();
  const importIndexes = new WeakMap<ParsedFile, Map<string, ParsedImport>>();
  return async (moduleFile: string, name: string, callerFile: string) => {
    const seen = new Map<string, boolean>();
    let file: string | null = moduleFile;
    let result: ResolvedExport | null = null;
    while (file) {
      const original = files.mixedCasePaths.get(file);
      if (original === null) {
        skip(callerFile, 'Multiple Git paths match the module ' + file);
        return null;
      }
      file = original ?? file;
      const key: string = file + '\0' + name;
      const cached = cache.get(key);
      if (cached !== undefined) {
        result = cached;
        break;
      }
      if (seen.has(key)) break;
      seen.set(key, original !== undefined);
      const parsed = await loadFile(file);
      const scope = parsed?.scopes.find((s) => s.id === parsed.moduleScope);
      if (!parsed || !scope) break;
      const selected = selectClaimsAtScope(scope, name);
      if (selected.status !== 'selected' || selected.claims.length !== 1) break;
      const claim = rangeKey(selected.claims[0].range);
      if (selected.claims[0].kind === 'binding') {
        const definition = definitions.get(key);
        if (definition?.declaration === claim)
          result = { change: definition, needsIndexedCall: false };
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
        { fromFile: file, allFilePaths: files.paths },
      );
      name = imp.importedName;
    }
    // Only imports upstream of a nonstandard suffix need an indexed call to corroborate them.
    for (const [key, mixedSuffix] of Array.from(seen).reverse()) {
      if (mixedSuffix && result && !result.needsIndexedCall)
        result = { ...result, needsIndexedCall: true };
      cache.set(key, result);
    }
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
  provider: LanguageProvider,
  directory: string,
  scope: string,
  base: string | undefined,
  targets: readonly CallCompatibilityTarget[],
  incoming: CallCompatibilityLookup,
  changedFiles: readonly CallCompatibilityFile[] = [],
): Promise<CallCompatibilityResult> {
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
  const result = (): CallCompatibilityResult => ({
    findings: findings.sort((a, b) => compareCodeUnits(a.filePath, b.filePath) || a.line - b.line),
    complete: skipped.size === 0,
    skipped: [...skipped].map(([filePath, reasons]) => ({
      filePath,
      reason: [...reasons].join('; '),
    })),
  });
  const parse = (file: string, source: Image) => {
    if (source === undefined) skip(file, 'Source unreadable or exceeds the 4 MiB file limit');
    if (source == null) return;
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
  const definitionPaths = [...definitions.keys()];
  const maxFiles = 4096;
  const maxSourceBytes = 64 * 1024 * 1024;
  if (definitionPaths.length > maxFiles)
    skip(
      definitionPaths[maxFiles],
      `Definition scan limit reached; ${definitionPaths.length - maxFiles} files omitted`,
    );
  let definitionBytes = 0;
  for await (const [file, oldText, newText] of definitionImages(
    cwd,
    before,
    after,
    definitionPaths.slice(0, maxFiles),
    oldPaths,
  )) {
    const symbols = definitions.get(file)!;
    definitionBytes += Buffer.byteLength(oldText ?? '') + Buffer.byteLength(newText ?? '');
    if (definitionBytes > maxSourceBytes) {
      skip(file, 'Definition scan reached the 64 MiB total source limit');
      break;
    }
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
      if (id && !oldDefs.has(id)) continue;
      if (id && !newDefs.has(id)) {
        skip(file, 'Declaration removed; keyword compatibility unavailable for ' + symbol.name);
        continue;
      }
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
        if (next.moduleLevel && !file.endsWith('.py'))
          skip(
            file,
            'Importers of a module with a nonstandard suffix may be missing from the index',
          );
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
  const supportedCallers = rows.filter((row) => {
    const file = newPaths.get(row.filePath) ?? row.filePath;
    if (isPythonSourceFile(file)) return true;
    skip(file, 'Caller source format is unsupported for keyword checking');
    return false;
  });
  // Edited notebooks may contain new call sites before a CALLS edge exists.
  for (const { filePath } of changedFiles) {
    if (isNotebookFilename(filePath))
      skip(filePath, 'Notebook cells are unsupported for keyword checking');
  }
  const graphFiles = groupBy(supportedCallers, (r) => newPaths.get(r.filePath) ?? r.filePath);
  const diffPaths = new Set(changedFiles.map((f) => f.filePath).filter(isPythonSourceFile));
  const files = [...new Set([...diffPaths].sort().concat([...graphFiles.keys()].sort()))];
  if (!files.length) return result();
  const allKeywords = new Set([...changed.values()].flatMap((c) => [...c.removed]));
  const anyVariadicRemoved = [...changed.values()].some((c) => c.stillAccepted !== undefined);
  const localDefs = new Map(
    [...changed.values()].map((c) => [c.target.filePath + '\0' + c.declaration, c]),
  );
  let moduleFiles: PythonModuleFiles | null | undefined;
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
    const parsed = extractParsedFile(provider, source, file, undefined, tree);
    if (!parsed) skip(file, 'Python scope extraction failed');
    return parsed ?? null;
  };
  const loadExport = async (file: string) => {
    const cached = exports.get(file);
    if (cached !== undefined) return cached;
    const source = await readImage(cwd, after, file);
    const tree = source === '' ? undefined : parse(file, source);
    let parsed = source && tree ? extract(file, source, tree) : null;
    if (source === null) skip(file, 'Imported module is missing from the source image');
    if (parsed?.parsedImports.some((imp) => imp.kind === 'wildcard')) {
      skip(file, 'Wildcard import may change the exported binding');
      parsed = null;
    }
    exports.set(file, parsed);
    return parsed;
  };
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
    if (graphCallers.some((c) => c.relationType === 'EXTENDS')) {
      skip(
        file,
        'Subclass constructor or super().__init__ forwarding may depend on the changed signature',
      );
    }
    callerBytes += Buffer.byteLength(text);
    if (callerBytes > maxSourceBytes) {
      skip(file, 'Caller scan reached the 64 MiB total source limit');
      break;
    }
    const indexedTargets = new Set(
      graphCallers.filter((c) => c.relationType === 'CALLS').map((c) => c.target),
    );
    const graphTargets = diffPaths.has(file) ? undefined : indexedTargets;
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
    // A star import can replace any lexical binding in this file through its runtime __all__.
    if (parsed.parsedImports.some((imp) => imp.kind === 'wildcard')) {
      skip(file, 'Wildcard import may change the call binding');
      continue;
    }
    const bindings = sourceBindings(parsed);
    for (const { call, explicit, unpacked } of calls) {
      const spelling = call.childForFieldName('function')?.text ?? '';
      const claims = bindings(call, spelling.split('.', 1)[0]);
      if (!claims) continue;
      const candidates = new Set<SignatureChange>();
      if ('declaration' in claims) {
        const local = !spelling.includes('.') && localDefs.get(file + '\0' + claims.declaration);
        if (local) candidates.add(local);
      } else {
        if (moduleFiles === undefined) moduleFiles = await pythonFiles(cwd, after);
        if (!moduleFiles) {
          skip(file, 'Python module inventory unavailable or exceeds the path limit');
          continue;
        }
        resolveExport ??= exportResolver(changed.values(), moduleFiles, loadExport, skip);
        for (const imp of claims) {
          const imported = importedCallee(imp, spelling, file, moduleFiles.paths);
          if (!imported?.file || imported.name.includes('.')) continue;
          const candidate = await resolveExport(imported.file, imported.name, file);
          if (!candidate) continue;
          if (candidate.needsIndexedCall && !indexedTargets.has(candidate.change.target.id)) {
            skip(
              file,
              'Cannot verify an import with a nonstandard module suffix without an indexed call',
            );
            continue;
          }
          candidates.add(candidate.change);
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
