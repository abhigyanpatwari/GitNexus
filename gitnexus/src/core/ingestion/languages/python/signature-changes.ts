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
import { compareCodeUnits } from '../../../../lib/utils.js';
import { nodeRange, rangeKey } from '../rename-tree-sitter.js';
import { splitImportStatement } from './import-decomposer.js';
import { getPythonFileIndex } from './import-file-index.js';
import { interpretPythonImport } from './interpret.js';
import {
  pythonDottedName,
  pythonNameResolver,
  walkPythonScopes,
  type PythonResolution,
  type PythonScope,
} from './type-imports.js';

const run = promisify(execFile);
const smallScopeTree = 12_000;
const maxFiles = 4096;
const maxSourceBytes = 64 * 1024 * 1024;
// Re-export endpoints read beyond the changed files themselves.
const maxEndpointReads = 256;
const maxExportHops = 4;
const maxAliasHops = 4;
type Node = Parser.SyntaxNode;
type SignatureChange = {
  target: CallCompatibilityTarget;
  removed: Set<string>;
  // When **kwargs is removed, every explicit name outside this set breaks.
  stillAccepted?: Set<string>;
  declaration: string;
  moduleLevel: boolean;
  // A base class the file cannot see may supply a metaclass `__call__`.
  inheritedMetaclass?: boolean;
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

/** Yield from a Git image reader until it fails; the failure is reported once. */
async function* guarded<T>(
  source: AsyncGenerator<T>,
  failed: (error: unknown) => void,
): AsyncGenerator<T> {
  try {
    for (;;) {
      let step: IteratorResult<T>;
      try {
        step = await source.next();
      } catch (error) {
        failed(error);
        return;
      }
      if (step.done) return;
      yield step.value;
    }
  } finally {
    await source.return(undefined);
  }
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
  inheritedMetaclass?: boolean;
};

type Definition = {
  key: string;
  name: string;
  node: Node;
  isClass: boolean;
  /** A function defined directly in a class body. */
  method: boolean;
  moduleLevel: boolean;
  signature: Signature | null;
};

type DefinitionIndex = {
  byKey: Map<string, Definition[]>;
  /** Initialization-relevant header text, or undefined past the copy budget. */
  fingerprint: (definitions: readonly Definition[]) => string | undefined;
  module: PythonScope;
  resolve: (scope: PythonScope, name: string) => PythonResolution;
};

const isMetaclassArgument = (node: Node) =>
  node.type === 'keyword_argument' || node.type.includes('splat');
// Builtin classes whose metaclass is `type`.
const builtinBases = new Set([
  'object',
  'int',
  'float',
  'complex',
  'str',
  'bytes',
  'bytearray',
  'list',
  'tuple',
  'dict',
  'set',
  'frozenset',
  'BaseException',
  'Exception',
]);
const isBuiltinBase = (name: string) =>
  builtinBases.has(name) || /^[A-Z][A-Za-z]*(?:Error|Exception|Warning)$/.test(name);
const compact = (text: string | undefined) => text?.replace(/\s+/g, ' ');

function readParameters(params: Node | null | undefined, isClass: boolean) {
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
    if (param.type === 'list_splat_pattern' || param.type === 'dictionary_splat_pattern') continue;
    if (name?.type === 'identifier') {
      if (isClass && i === 0) receiver = name.text;
      else keywords.add(name.text);
    }
  }
  return { keywords, arbitrary, receiver };
}

/**
 * Every class and function definition in one image, keyed by its lexical
 * path, from a single top-down walk. Fingerprints are computed only when a
 * comparison needs them and share a copy budget proportional to the source.
 */
function definitionIndex(root: Node): DefinitionIndex {
  const decorators = new Map<number, Node[]>();
  const classScopes = new Map<number, PythonScope>();
  const records: { node: Node; scope: PythonScope }[] = [];
  const module = walkPythonScopes(root, (node, at) => {
    switch (node.type) {
      case 'decorated_definition': {
        const definition = node.childForFieldName('definition');
        if (definition)
          decorators.set(
            definition.id,
            node.namedChildren.filter((child) => child.type === 'decorator'),
          );
        return;
      }
      case 'function_definition':
      case 'class_definition':
        records.push({ node, scope: at.scope });
        return;
      case 'block':
        if (at.scope.kind === 'class') classScopes.set(at.scope.node.id, at.scope);
        return;
    }
  });
  const resolve = pythonNameResolver();
  const proven = new Map<number, boolean>();
  // Only a base chain that ends in builtins within this file proves `type.__call__`.
  const defaultMetaclass = (node: Node, scope: PythonScope, depth: number): boolean => {
    const known = proven.get(node.id);
    if (known !== undefined) return known;
    if (depth > 32) return false;
    proven.set(node.id, false);
    let result = true;
    for (const base of node.childForFieldName('superclasses')?.namedChildren ?? []) {
      if (base.type !== 'identifier') {
        result = false;
        break;
      }
      const found = resolve(scope, base.text);
      if (!found) {
        if (isBuiltinBase(base.text)) continue;
        result = false;
        break;
      }
      const [binding] = found.bindings;
      const statement = binding.statement;
      if (
        found.bindings.length !== 1 ||
        binding.kind !== 'definition' ||
        statement.type !== 'class_definition' ||
        binding.conditional ||
        binding.decorated ||
        statement.childForFieldName('superclasses')?.namedChildren.some(isMetaclassArgument) ||
        !defaultMetaclass(statement, found.scope, depth + 1)
      ) {
        result = false;
        break;
      }
    }
    proven.set(node.id, result);
    return result;
  };

  const byKey = new Map<string, Definition[]>();
  const byNode = new Map<number, Definition>();
  for (const { node, scope } of records) {
    const name = node.childForFieldName('name')?.text;
    if (!name) continue;
    const isClass = node.type === 'class_definition';
    const key = (isClass ? 'Class:' : 'Function:') + [...scope.path, name].join('.');
    const definition: Definition = {
      key,
      name,
      node,
      isClass,
      method: !isClass && scope.kind === 'class',
      moduleLevel: scope.path.length === 0,
      signature: signatureOf(node, scope, isClass),
    };
    byNode.set(node.id, definition);
    const list = byKey.get(key);
    if (list) list.push(definition);
    else byKey.set(key, [definition]);
  }

  function signatureOf(def: Node, scope: PythonScope, isClass: boolean): Signature | null {
    const decorated = decorators.get(def.id);
    if (isClass && decorated) return null;
    const bases = def.childForFieldName('superclasses');
    if (isClass && bases?.namedChildren.some(isMetaclassArgument)) return null;
    const body = isClass ? def.childForFieldName('body') : null;
    let initializer: Node | undefined;
    if (body) {
      // Only a final, unconditional method definition proves the class's keyword contract.
      const bound = (name: string) =>
        (classScopes.get(def.id)?.bindings.get(name) ?? []).filter(
          (binding) => binding.kind !== 'annotation',
        );
      if (bound('__new__').length) return null;
      const last = bound('__init__').at(-1);
      if (last) {
        if (
          last.kind !== 'definition' ||
          last.statement.type !== 'function_definition' ||
          last.conditional ||
          last.decorated
        )
          return null;
        initializer = last.statement;
      }
    }
    const callable = isClass ? initializer : def;
    const params = callable?.childForFieldName('parameters');
    if (!params) {
      // Only infer object.__init__ for a plain class body. Bases, decorators
      // and class-body code can supply a constructor that accepts keywords.
      const defaultConstructor =
        isClass &&
        !bases?.namedChildCount &&
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
      if (!defaultConstructor) return null;
    }
    const { keywords, arbitrary, receiver } = readParameters(params, isClass);
    return {
      moduleLevel: scope.path.length === 0,
      keywords,
      arbitrary,
      receiver,
      declaration: rangeKey(nodeRange(def)),
      ...(isClass &&
        bases?.namedChildCount &&
        !defaultMetaclass(def, scope, 0) && { inheritedMetaclass: true }),
      // A body-only edit has no new static signature to compare. If the
      // decorators or header moved semantically, the wrapper contract is unknown.
      ...(decorated && {
        decoratedHeader: JSON.stringify([
          ...decorated.map((node) => compact(node.text)),
          compact(def.childForFieldName('type_parameters')?.text),
          compact(params?.text),
          compact(def.childForFieldName('return_type')?.text),
        ]),
      }),
    };
  }

  let budget = 2 * (root.endIndex - root.startIndex) + 4096;
  const memo = new Map<number, string | undefined>();
  const copy = (node: Node | null | undefined) => {
    if (!node) return '';
    budget -= node.endIndex - node.startIndex;
    return compact(node.text) ?? '';
  };
  const header = (def: Node) =>
    JSON.stringify([
      ...(decorators.get(def.id) ?? []).map(copy),
      copy(def.childForFieldName('type_parameters')),
      copy(def.childForFieldName('parameters')),
      copy(def.childForFieldName('return_type')),
    ]);
  // Bases, decorators, initializer headers and class-level fields decide what
  // a constructor accepts. Method bodies and docstrings do not.
  const fingerprintOf = (def: Node, depth: number): string | undefined => {
    if (memo.has(def.id)) return memo.get(def.id);
    let result: string | undefined;
    if (def.type === 'function_definition') result = header(def);
    else if (depth <= 64) {
      const parts = [header(def), copy(def.childForFieldName('superclasses'))];
      for (const member of def.childForFieldName('body')?.namedChildren ?? []) {
        const inner =
          member.type === 'decorated_definition' ? member.childForFieldName('definition') : member;
        if (
          member.type === 'comment' ||
          member.type === 'pass_statement' ||
          (member.type === 'expression_statement' &&
            member.firstNamedChild?.type === 'string' &&
            member.namedChildCount === 1)
        )
          continue;
        if (inner?.type === 'function_definition')
          parts.push('def ' + copy(inner.childForFieldName('name')) + header(inner));
        else if (inner?.type === 'class_definition') {
          const nested = fingerprintOf(inner, depth + 1);
          if (nested === undefined) return undefined;
          parts.push('class ' + nested);
        } else parts.push(copy(member));
      }
      result = JSON.stringify(parts);
    }
    if (budget < 0) result = undefined;
    memo.set(def.id, result);
    return result;
  };
  return {
    byKey,
    module,
    resolve,
    fingerprint: (definitions) => {
      const parts: string[] = [];
      for (const definition of definitions) {
        const value = fingerprintOf(definition.node, 0);
        if (value === undefined) return undefined;
        parts.push(value);
      }
      return parts.join('\n');
    },
  };
}

type Comparison =
  | { kind: 'same' }
  | { kind: 'unknown'; reason: string }
  | { kind: 'changed'; removed: Set<string>; stillAccepted?: Set<string>; next: Signature };

function compareDefinitions(
  before: DefinitionIndex,
  after: DefinitionIndex,
  previous: readonly Definition[],
  next: readonly Definition[],
  name: string,
): Comparison {
  const prev = previous.length === 1 ? previous[0].signature : null;
  const now = next.length === 1 ? next[0].signature : null;
  if (prev && now) {
    if (prev.decoratedHeader !== undefined || now.decoratedHeader !== undefined) {
      return prev.decoratedHeader === now.decoratedHeader
        ? { kind: 'same' }
        : {
            kind: 'unknown',
            reason: 'Decorated callable signature cannot be verified for ' + name,
          };
    }
    if (now.arbitrary) return { kind: 'same' };
    const removed = new Set([...prev.keywords].filter((keyword) => !now.keywords.has(keyword)));
    if (!removed.size && !prev.arbitrary) return { kind: 'same' };
    // Passing the bound receiver by keyword was already invalid, even
    // with **kwargs (unless it was positional-only).
    const stillAccepted = prev.arbitrary ? new Set(now.keywords) : undefined;
    if (prev.receiver) stillAccepted?.add(prev.receiver);
    return { kind: 'changed', removed, stillAccepted, next: now };
  }
  // An unreadable or conditional contract is unchanged only if every
  // initialization-relevant header is.
  const old = before.fingerprint(previous);
  if (old !== undefined && old === after.fingerprint(next)) return { kind: 'same' };
  return { kind: 'unknown', reason: 'Signature unavailable or ambiguous for ' + name };
}

type NamedImport = Extract<ParsedImport, { kind: 'named' | 'alias' }>;
type ModuleImport = { statement: Node; imp: NamedImport };
const importStatementMemo = new WeakMap<DefinitionIndex, Map<string, Node>>();
const decodedImports = new WeakMap<Node, NamedImport[]>();
// The decomposer climbs ancestors per statement, so only changed or followed
// imports are decoded, and at most this many per request.
const maxDecodedImports = 4096;

/** Module-level names bound by exactly one unconditional import statement. */
function importStatements(index: DefinitionIndex) {
  let statements = importStatementMemo.get(index);
  if (statements) return statements;
  statements = new Map();
  for (const [name, bindings] of index.module.bindings) {
    const [binding] = bindings;
    if (bindings.length === 1 && binding.kind === 'import' && !binding.conditional)
      statements.set(name, binding.statement);
  }
  importStatementMemo.set(index, statements);
  return statements;
}

function importDecoder() {
  let decoded = 0;
  return (index: DefinitionIndex, name: string): ModuleImport | 'unknown' | undefined => {
    const statement = importStatements(index).get(name);
    if (!statement) return;
    let parsed = decodedImports.get(statement);
    if (!parsed) {
      if (++decoded > maxDecodedImports) return 'unknown';
      parsed = splitImportStatement(statement).flatMap((match) => {
        const imp = interpretPythonImport(match);
        return imp && (imp.kind === 'named' || imp.kind === 'alias') ? [imp] : [];
      });
      decodedImports.set(statement, parsed);
    }
    const imp = parsed.find((candidate) => candidate.localName === name);
    return imp && { statement, imp };
  };
}

function sourceBindings(parsed: ParsedFile) {
  const scopes = new Map(parsed.scopes.map((scope) => [scope.id, scope]));
  const scopeIds = new Map(parsed.scopes.map((scope) => [rangeKey(scope.range), scope.id]));
  const anchors = new Map<string, string>();
  for (const site of parsed.referenceSites) {
    if (site.kind === 'call' || site.kind === 'read')
      anchors.set(site.kind + rangeKey(site.atRange), site.lookupScope ?? site.inScope);
  }
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
  const scopeIdMemo = new Map<PythonScope, string | undefined>();
  return {
    /** The extractor's lookup scope for a call or read site at `node`. */
    anchor: (kind: 'call' | 'read', node: Node) => anchors.get(kind + rangeKey(nodeRange(node))),
    /** The extractor scope matching a walker scope, or its nearest recorded ancestor. */
    scopeOf(scope: PythonScope): string | undefined {
      const chain: PythonScope[] = [];
      let id: string | undefined;
      for (let current: PythonScope | undefined = scope; current; current = current.parent) {
        if (scopeIdMemo.has(current)) {
          id = scopeIdMemo.get(current);
          break;
        }
        chain.push(current);
        id = scopeIds.get(rangeKey(nodeRange(current.node)));
        if (id) break;
      }
      id ??= parsed.moduleScope;
      for (const visited of chain) scopeIdMemo.set(visited, id);
      return id;
    },
    lookup(anchor: string, head: string, node: Node) {
      const position = nodeRange(node);
      const selected = lookupLexicalName(anchor, head, sources, { position, purpose: 'value' });
      return {
        imports: selected.imports.flatMap((edge) => {
          const imp = imports.get(edge);
          return imp ? [imp] : [];
        }),
        declarations: selected.bindings.map((binding) => {
          const range = binding.declarationRange ?? binding.def.declarationRange;
          return binding.origin === 'local' && range ? rangeKey(range) : undefined;
        }),
      };
    },
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
      // A moved definition is anchored on the import that now provides it.
      const definition = definitions.get(key);
      if (definition?.declaration === claim) {
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

// An unindexed caller can import a renamed re-export without spelling its target.
// Only reject it when every import starts in a module absent from this repository.
function mayImportLocalModule(root: Node, paths: Set<string>): boolean {
  const files = getPythonFileIndex(paths);
  return root.descendantsOfType(['import_from_statement', 'import_statement']).some((statement) => {
    const source = statement.childForFieldName('module_name');
    // Plain, relative and unrecognized imports take the full attribution path.
    if (source?.type !== 'dotted_name') return true;
    const name = source.firstNamedChild?.text;
    return (
      !name ||
      files.byBasename.has(name + '.py') ||
      files.dirPrefixes.has(name + '/') ||
      files.nestedDirParents.has(name)
    );
  });
}

const densitySites = new Set([
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

// Scope extraction grows superlinearly for thousands of bindings in one
// scope. Large functions made up mostly of expressions can still be cheap.
function tooDenseForScopeExtraction(root: Node): boolean {
  if (root.descendantCount <= smallScopeTree) return false;
  if (root.descendantCount > 64_000) return true;
  const weights = new Map<PythonScope, number>();
  let dense = false;
  walkPythonScopes(root, (site, at) => {
    if (!densitySites.has(site.type)) return;
    // The extractor does not model comprehension scopes.
    const owner = at.scope.owner;
    const target = site.childForFieldName('left') ?? site.childForFieldName('name');
    const weight = target?.descendantCount ?? Math.max(1, site.namedChildCount);
    const total = (weights.get(owner) ?? 0) + weight;
    weights.set(owner, total);
    if (total > 1_500) {
      dense = true;
      return 'stop';
    }
  });
  return dense;
}

type CallSite = {
  call: Node;
  scope: PythonScope;
  explicit: string[];
  /** A `**mapping` whose keys are not written at the call. */
  unpacked: boolean;
};
type Receiver = { owner: Node; kind: 'class' | 'instance' };
type Alias = { value: string; head: Node; scope: PythonScope };
const classReceiverMethods = new Set(['__new__', '__init_subclass__', '__class_getitem__']);

/** The string keys of a `**{...}` literal, or undefined for any computed mapping. */
function literalKeys(splat: Node): string[] | undefined {
  let value = splat.firstNamedChild;
  while (value?.type === 'parenthesized_expression' && value.namedChildCount === 1)
    value = value.firstNamedChild;
  if (value?.type !== 'dictionary') return undefined;
  const keys: string[] = [];
  for (const entry of value.namedChildren) {
    if (entry.type === 'comment') continue;
    const key = entry.type === 'pair' ? entry.childForFieldName('key') : null;
    const parts = key?.type === 'string' ? key.namedChildren : [];
    // Prefixes, escapes and interpolation change or compute the runtime key.
    if (
      parts.length !== 3 ||
      parts[1].type !== 'string_content' ||
      !/^(?:'|"|'''|""")$/.test(parts[0].text) ||
      !/^[A-Za-z_]\w*$/.test(parts[1].text)
    )
      return undefined;
    keys.push(parts[1].text);
  }
  return keys;
}

export async function findBrokenKeywordCalls(
  provider: LanguageProvider,
  directory: string,
  scope: string,
  base: string | undefined,
  targets: readonly CallCompatibilityTarget[],
  incoming: CallCompatibilityLookup,
  changedFiles: readonly CallCompatibilityFile[] = [],
  /** When set, only source images of the changed files may be inspected. */
  callerSourceUnavailable?: string,
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
  const readFailure = (file: string, what: string) => (error: unknown) =>
    skip(
      file,
      `${what} could not be read from Git; later files were not checked (${
        (error as Error)?.message?.split('\n', 1)[0] ?? 'unknown error'
      })`,
    );
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
  const removedTargets = new Map<string, CallCompatibilityTarget>();
  const newPaths = new Map(
    changedFiles.flatMap((f) => (f.oldFilePath ? [[f.oldFilePath, f.filePath] as const] : [])),
  );
  const oldPaths = new Map(changedFiles.map((f) => [f.filePath, f.oldFilePath ?? f.filePath]));
  const definitions = groupBy(targets, (t) => newPaths.get(t.filePath) ?? t.filePath);
  const diffPaths = new Set(changedFiles.map((f) => f.filePath).filter(isPythonSourceFile));
  // Every changed Python module is compared, including one without indexed targets.
  const definitionPaths = [...new Set([...definitions.keys(), ...diffPaths])];
  if (definitionPaths.length > maxFiles)
    skip(
      definitionPaths[maxFiles],
      `Definition scan limit reached; ${definitionPaths.length - maxFiles} files omitted`,
    );
  let definitionBytes = 0;
  const inventories = new Map<string | undefined, Promise<PythonModuleFiles | null>>();
  const inventory = (rev: string | undefined) => {
    let files = inventories.get(rev);
    if (!files) {
      files = pythonFiles(cwd, rev).catch(() => null);
      inventories.set(rev, files);
    }
    return files;
  };
  let endpointReads = 0;
  const moduleImport = importDecoder();
  type Endpoint = { file: string; definitions: Definition[]; index: DefinitionIndex };
  // Follow named re-exports to the definition a module name provides in one
  // image. 'external' leaves the repository; 'unknown' could not be followed.
  const endpoint = async (
    rev: string | undefined,
    start: { file: string; index: DefinitionIndex },
    name: string,
  ): Promise<Endpoint | 'external' | 'unknown'> => {
    let { file, index } = start;
    for (let hop = 0; hop <= maxExportHops; hop++) {
      const local = ['Function:', 'Class:'].flatMap((kind) => index.byKey.get(kind + name) ?? []);
      if (local.length) return { file, definitions: local, index };
      const imported = moduleImport(index, name);
      if (imported === 'unknown') return 'unknown';
      if (!imported) return hop === 0 ? 'external' : 'unknown';
      const files = await inventory(rev);
      if (!files) return 'unknown';
      const resolved = resolvePythonImportTarget(
        { ...imported.imp, targetIncludesImportedName: true },
        { fromFile: file, allFilePaths: files.paths },
      );
      if (!resolved) return 'external';
      // Reading the imported module would inspect a file outside the diff.
      if (callerSourceUnavailable && !diffPaths.has(resolved)) return 'unknown';
      const next = files.mixedCasePaths.get(resolved) ?? resolved;
      if (
        files.mixedCasePaths.get(resolved) === null ||
        !isPythonSourceFile(next) ||
        ++endpointReads > maxEndpointReads
      )
        return 'unknown';
      let text: Image;
      try {
        text = await readImage(cwd, rev, next);
      } catch {
        return 'unknown';
      }
      definitionBytes += Buffer.byteLength(text ?? '');
      if (definitionBytes > maxSourceBytes) return 'unknown';
      const tree = text ? parse(next, text) : undefined;
      if (!tree) return 'unknown';
      file = next;
      index = definitionIndex(tree.rootNode);
      name = imported.imp.importedName;
    }
    return 'unknown';
  };

  let processed = 0;
  for await (const [file, oldText, newText] of guarded(
    definitionImages(cwd, before, after, definitionPaths.slice(0, maxFiles), oldPaths),
    (error) => readFailure(definitionPaths[processed] ?? '.', 'Definition images')(error),
  )) {
    processed++;
    const symbols = definitions.get(file) ?? [];
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
    const oldIndex = definitionIndex(oldTree.rootNode);
    const newIndex = definitionIndex(newTree.rootNode);
    const oldDefs = oldIndex.byKey;
    const newDefs = newIndex.byKey;
    const byName = groupBy([...new Set([...oldDefs.keys(), ...newDefs.keys()])], (key) => {
      const [kind, name] = key.split(':');
      return kind + ':' + name.split('.').at(-1);
    });
    const symbolGroups = groupBy(symbols, (s) => s.type + ':' + s.name);
    const supplied = new Set<string>();
    const record = (symbol: CallCompatibilityTarget, comparison: Comparison, anchor?: string) => {
      if (comparison.kind === 'same') return;
      if (comparison.kind === 'unknown') {
        skip(file, comparison.reason);
        return;
      }
      const { removed, stillAccepted, next } = comparison;
      if (next.moduleLevel && !file.endsWith('.py'))
        skip(file, 'Importers of a module with a nonstandard suffix may be missing from the index');
      changed.set(symbol.id, {
        target: { ...symbol, filePath: file },
        removed,
        stillAccepted,
        declaration: anchor ?? next.declaration,
        moduleLevel: anchor !== undefined || next.moduleLevel,
        ...(next.inheritedMetaclass && { inheritedMetaclass: true }),
      });
    };
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
      if (!id) {
        if (!options.length) continue;
        // Withhold a match for an opaque ID unless no same-named definition moved.
        for (const key of options) supplied.add(key);
        const same = options.every(
          (key) =>
            compareDefinitions(
              oldIndex,
              newIndex,
              oldDefs.get(key) ?? [],
              newDefs.get(key) ?? [],
              symbol.name,
            ).kind === 'same',
        );
        if (!same) skip(file, 'Signature unavailable or ambiguous for ' + symbol.name);
        continue;
      }
      supplied.add(id);
      const prev = oldDefs.get(id);
      if (!prev) continue;
      const next = newDefs.get(id);
      if (next) {
        record(symbol, compareDefinitions(oldIndex, newIndex, prev, next, symbol.name));
        continue;
      }
      // A module-level definition can move behind an import of the same name.
      const imported =
        prev.length === 1 && prev[0].moduleLevel ? moduleImport(newIndex, symbol.name) : undefined;
      const moved = imported === 'unknown' ? undefined : imported;
      const destination =
        imported === 'unknown'
          ? 'unknown'
          : moved
            ? await endpoint(after, { file, index: newIndex }, symbol.name)
            : 'external';
      if (destination === 'external') {
        removedTargets.set(symbol.id, { ...symbol, filePath: file });
        continue;
      }
      if (!moved || destination === 'unknown') {
        skip(file, 'Signature unavailable for ' + symbol.name + ' after it moved behind an import');
        continue;
      }
      record(
        symbol,
        compareDefinitions(oldIndex, destination.index, prev, destination.definitions, symbol.name),
        rangeKey(nodeRange(moved.statement)),
      );
    }
    // A definition whose contract changed but was not supplied cannot be
    // checked against its callers. Methods are outside this check.
    for (const [key, prev] of oldDefs) {
      const next = newDefs.get(key);
      if (!next || supplied.has(key) || prev.some((def) => def.method)) continue;
      const name = key.slice(key.indexOf(':') + 1);
      const comparison = compareDefinitions(oldIndex, newIndex, prev, next, name);
      if (comparison.kind !== 'same')
        skip(file, `Signature changed for ${name}, but no indexed target was supplied`);
    }
    // A re-export that now names another definition changes what its
    // importers call, though neither definition changed.
    // Only statements whose text changed are decoded.
    const oldStatements = importStatements(oldIndex);
    for (const [name, statement] of importStatements(newIndex)) {
      const previous = oldStatements.get(name);
      if (!previous || compact(previous.text) === compact(statement.text)) continue;
      const was = moduleImport(oldIndex, name);
      const now = moduleImport(newIndex, name);
      if (was === 'unknown' || now === 'unknown') {
        skip(file, 'Re-export comparison limit reached; ' + name + ' was not compared');
        continue;
      }
      if (
        !was ||
        !now ||
        (was.imp.targetRaw === now.imp.targetRaw && was.imp.importedName === now.imp.importedName)
      )
        continue;
      const [from, to] = await Promise.all([
        endpoint(before, { file: oldPaths.get(file) ?? file, index: oldIndex }, name),
        endpoint(after, { file, index: newIndex }, name),
      ]);
      // Only an indexed definition had callers through this module whose
      // keywords the diff can break; an external one was never checked.
      if (from === 'external') continue;
      if (typeof from === 'object' && typeof to === 'object') {
        const comparison = compareDefinitions(
          from.index,
          to.index,
          from.definitions,
          to.definitions,
          name,
        );
        if (comparison.kind === 'same') continue;
      }
      const describe = (end: typeof to, raw: string | undefined) =>
        typeof end === 'object' ? end.file : (raw ?? name);
      skip(
        file,
        `Re-export ${name} now resolves to ${describe(to, now.imp.targetRaw)} instead of ${describe(
          from,
          was.imp.targetRaw,
        )}; keyword calls through this module are not verified`,
      );
    }
  }
  if (!changed.size && !removedTargets.size) return result();
  const removedDeclaration = (removed: CallCompatibilityTarget) =>
    skip(
      removed.filePath,
      'Declaration removed; keyword compatibility unavailable for ' + removed.name,
    );
  let rows: Awaited<ReturnType<CallCompatibilityLookup>> = [];
  if (callerSourceUnavailable) {
    // Indexed callers cannot be read. Calls inside the diff are still checked.
    for (const change of changed.values()) skip(change.target.filePath, callerSourceUnavailable);
    for (const removed of removedTargets.values()) removedDeclaration(removed);
  } else {
    rows = await incoming([...changed.keys(), ...removedTargets.keys()]);
    // A deleted declaration is only a compatibility question if something
    // still calls it: an indexed caller outside the diff, or one in the diff
    // whose new image still names it.
    const callersOf = groupBy(
      rows.filter((row) => removedTargets.has(row.target)),
      (row) => row.target,
    );
    for (const [id, callers] of callersOf) {
      const removed = removedTargets.get(id);
      if (!removed) continue;
      const files = new Set(callers.map((row) => newPaths.get(row.filePath) ?? row.filePath));
      let live = [...files].some((caller) => !diffPaths.has(caller));
      for (const caller of files) {
        if (live) break;
        let text: Image;
        try {
          text = await readImage(cwd, after, caller);
        } catch {
          text = undefined;
        }
        definitionBytes += Buffer.byteLength(text ?? '');
        live =
          text === undefined || definitionBytes > maxSourceBytes || !!text?.includes(removed.name);
      }
      if (live) removedDeclaration(removed);
    }
  }
  if (!changed.size) return result();
  const supportedCallers = rows.filter((row) => {
    if (!changed.has(row.target)) return false;
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
  const files = [...new Set([...diffPaths].sort().concat([...graphFiles.keys()].sort()))];
  if (!files.length) return result();
  const allKeywords = new Set([...changed.values()].flatMap((c) => [...c.removed]));
  const anyVariadicRemoved = [...changed.values()].some((c) => c.stillAccepted !== undefined);
  const allNames = [...new Set([...changed.values()].map((c) => c.target.name))];
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
  const extractionExhausted = () => extractions >= 256 || remainingNodes <= 0;
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
  // Imported modules share the caller byte budget and have their own file cap.
  let callerBytes = 0;
  let moduleReads = 0;
  const loadExport = async (file: string) => {
    const cached = exports.get(file);
    if (cached !== undefined) return cached;
    let parsed: ParsedFile | null = null;
    exports.set(file, null);
    if (callerSourceUnavailable && !diffPaths.has(file)) {
      skip(file, callerSourceUnavailable);
      return null;
    }
    if (++moduleReads > maxFiles || callerBytes > maxSourceBytes) {
      skip(file, 'Imported module read budget exhausted');
      return null;
    }
    if (extractionExhausted()) {
      skip(file, 'Python scope extraction budget exceeded');
      return null;
    }
    let source: Image;
    try {
      source = await readImage(cwd, after, file);
    } catch (error) {
      readFailure(file, 'Imported module')(error);
      return null;
    }
    callerBytes += Buffer.byteLength(source ?? '');
    if (callerBytes > maxSourceBytes) {
      skip(file, 'Imported module reads reached the 64 MiB total source limit');
      return null;
    }
    const tree = source === '' ? undefined : parse(file, source);
    parsed = source && tree ? extract(file, source, tree) : null;
    if (source === null) skip(file, 'Imported module is missing from the source image');
    if (parsed?.parsedImports.some((imp) => imp.kind === 'wildcard')) {
      skip(file, 'Wildcard import may change the exported binding');
      parsed = null;
    }
    exports.set(file, parsed);
    return parsed;
  };
  const keywordsFor = new Map<string, Set<string>>();
  if (files.length > maxFiles)
    skip(files[maxFiles], `Caller scan limit reached; ${files.length - maxFiles} files omitted`);
  let scanned = 0;
  for await (const [file, text] of guarded(
    callerImages(cwd, after, files.slice(0, maxFiles)),
    (error) => readFailure(files[scanned] ?? '.', 'Caller images')(error),
  )) {
    scanned++;
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
    let keywords = allKeywords;
    if (graphTargets) {
      const id = [...graphTargets].sort().join('\0');
      keywords =
        keywordsFor.get(id) ??
        new Set([...graphTargets].flatMap((target) => [...(changed.get(target)?.removed ?? [])]));
      keywordsFor.set(id, keywords);
    }
    const variadicRemoved = graphTargets
      ? [...graphTargets].some((id) => changed.get(id)?.stillAccepted !== undefined)
      : anyVariadicRemoved;
    const mapping = text.includes('**');
    const explicit = variadicRemoved
      ? text.includes('=')
      : keywords.size > 24 || [...keywords].some((keyword) => text.includes(keyword));
    if (!explicit && !mapping) continue;
    if (extractionExhausted()) {
      skip(file, 'Python scope extraction budget exceeded');
      continue;
    }
    const tree = parse(file, text);
    if (!tree) continue;
    if (!explicit && !indexedTargets.size && !allNames.some((name) => text.includes(name))) {
      moduleFiles ??= await inventory(after);
      if (moduleFiles && !mayImportLocalModule(tree.rootNode, moduleFiles.paths)) continue;
    }
    const calls: CallSite[] = [];
    const receivers = new Map<number, Receiver>();
    const aliases = new Map<string, Alias>();
    const decorators = new Map<number, string[]>();
    walkPythonScopes(tree.rootNode, (node, at) => {
      switch (node.type) {
        case 'call': {
          const args = node.childForFieldName('arguments')?.namedChildren ?? [];
          const explicit: string[] = [];
          let unpacked = false;
          for (const arg of args) {
            if (arg.type === 'keyword_argument') {
              const keyword = arg.childForFieldName('name')?.text;
              if (keyword && (variadicRemoved || keywords.has(keyword))) explicit.push(keyword);
            } else if (arg.type === 'dictionary_splat') {
              const literal = literalKeys(arg);
              if (literal) explicit.push(...literal);
              else unpacked = true;
            }
          }
          if (explicit.length || unpacked)
            calls.push({ call: node, scope: at.scope, explicit, unpacked });
          return;
        }
        case 'assignment': {
          // `Alias = name` or `Alias = module.name`, followed when a call uses Alias.
          const left = node.childForFieldName('left');
          const right = node.childForFieldName('right');
          const value = pythonDottedName(right);
          if (left?.type === 'identifier' && value) {
            let head = right;
            while (head && head.type !== 'identifier')
              head =
                head.type === 'attribute' ? head.childForFieldName('object') : head.firstNamedChild;
            if (head) aliases.set(rangeKey(nodeRange(node)), { value, head, scope: at.scope });
          }
          return;
        }
        case 'decorated_definition': {
          const definition = node.childForFieldName('definition');
          if (definition)
            decorators.set(
              definition.id,
              node.namedChildren
                .filter((child) => child.type === 'decorator')
                .map(
                  (child) =>
                    child.namedChildren.find((part) => part.type !== 'comment')?.text ?? '',
                ),
            );
          return;
        }
        case 'function_definition': {
          if (at.scope.kind !== 'class') return;
          const first = node.childForFieldName('parameters')?.firstNamedChild;
          const name =
            first?.type === 'identifier'
              ? first
              : (first?.childForFieldName('name') ?? first?.firstNamedChild);
          if (name?.type !== 'identifier') return;
          const wrappers = decorators.get(node.id) ?? [];
          if (wrappers.includes('staticmethod')) return;
          const method = node.childForFieldName('name')?.text ?? '';
          receivers.set(name.id, {
            owner: at.scope.node,
            kind:
              wrappers.includes('classmethod') || classReceiverMethods.has(method)
                ? 'class'
                : 'instance',
          });
          return;
        }
      }
    });
    if (!calls.length) continue;
    const parsed = extract(file, text, tree);
    if (!parsed) continue;
    // A star import can replace any lexical binding in this file through its runtime __all__.
    if (parsed.parsedImports.some((imp) => imp.kind === 'wildcard')) {
      skip(file, 'Wildcard import may change the call binding');
      continue;
    }
    const lexical = sourceBindings(parsed);
    const resolveName = pythonNameResolver();
    type Outcome = { change: SignatureChange; proven: boolean; why?: string } | undefined;
    const owned = (owner: Node): Outcome => {
      const change = localDefs.get(file + '\0' + rangeKey(nodeRange(owner)));
      return change && { change, proven: true };
    };
    const receiverOf = (scope: PythonScope, name: string, kind: Receiver['kind']) => {
      const found = resolveName(scope, name);
      if (found?.bindings.length !== 1 || found.bindings[0].kind !== 'parameter') return;
      const receiver = receivers.get(found.bindings[0].node.id);
      return receiver?.kind === kind ? receiver.owner : undefined;
    };
    const importsAt = new Map<string, ParsedImport[]>();
    for (const imp of parsed.parsedImports) {
      if (!imp.atRange || !('localName' in imp)) continue;
      const key = rangeKey(imp.atRange) + '\0' + imp.localName.split('.', 1)[0];
      const list = importsAt.get(key);
      if (list) list.push(imp);
      else importsAt.set(key, [imp]);
    }
    const importCandidates = async (imports: readonly ParsedImport[], spelling: string) => {
      const candidates = new Set<SignatureChange>();
      if (moduleFiles === undefined) moduleFiles = await inventory(after);
      if (!moduleFiles) {
        skip(file, 'Python module inventory unavailable or exceeds the path limit');
        return candidates;
      }
      resolveExport ??= exportResolver(changed.values(), moduleFiles, loadExport, skip);
      for (const imp of imports) {
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
      return candidates;
    };
    // Follow `Alias = name` to what its right-hand side names where it runs.
    const followAlias = async (declaration: string, rest: string, hops: number) => {
      const alias = aliases.get(declaration);
      if (!alias || hops >= maxAliasHops) return;
      return resolveSpelling(
        alias.value + rest,
        lexical.anchor('read', alias.head),
        alias.head,
        alias.scope,
        hops + 1,
      );
    };
    // The single choke point: a changed target, uncertainty about one, or unrelated.
    const resolveSpelling = async (
      spelling: string,
      anchor: string | undefined,
      at: Node,
      scope: PythonScope,
      hops: number,
    ): Promise<Outcome> => {
      const head = spelling.split('.', 1)[0];
      const rest = spelling.slice(head.length);
      const dotted = rest !== '';
      anchor ??= lexical.scopeOf(scope);
      if (!anchor) return;
      const selected = lexical.lookup(anchor, head, at);
      let primary: Outcome;
      let primaryCount = 0;
      if (selected.imports.length) {
        const candidates = await importCandidates(selected.imports, spelling);
        const [change] = candidates;
        primaryCount = candidates.size;
        primary = change && { change, proven: candidates.size === 1, why: 'Conditional imports' };
      } else if (!selected.declarations.length) {
        // Parameters and builtins are not extractor bindings. Only `cls` inside
        // a changed class's own class methods is attributable.
        const owner = !dotted && receiverOf(scope, head, 'class');
        primary = owner ? owned(owner) : undefined;
      } else {
        const changes = new Set<SignatureChange>();
        for (const declaration of selected.declarations) {
          if (!declaration) continue;
          const local = !dotted && localDefs.get(file + '\0' + declaration);
          const outcome = local
            ? { change: local, proven: true }
            : await followAlias(declaration, rest, hops);
          if (!outcome) continue;
          changes.add(outcome.change);
          primary ??= { ...outcome, why: outcome.why ?? 'A local alias' };
          if (!outcome.proven) primary = { ...primary, proven: false };
        }
        primaryCount = changes.size;
        if (primary && (selected.declarations.length !== 1 || changes.size !== 1))
          primary = { ...primary, proven: false, why: 'An ambiguous binding' };
      }
      // The extractor keeps the latest binding. A branch can leave an earlier one live.
      const found = resolveName(scope, head);
      if (!found || found.bindings.length < 2 || !found.bindings.some((b) => b.conditional))
        return primary;
      const alternatives = new Set<SignatureChange>(primary ? [primary.change] : []);
      // Each live binding must name the same changed target for the call to be proven.
      let unanimous = primary?.proven === true && primaryCount === 1;
      for (const binding of found.bindings) {
        const declaration = rangeKey(nodeRange(binding.statement));
        const named = new Set<SignatureChange>();
        if (binding.kind === 'definition') {
          const local = !dotted && localDefs.get(file + '\0' + declaration);
          if (local) named.add(local);
        } else if (binding.kind === 'assignment') {
          const outcome = await followAlias(declaration, rest, hops);
          if (outcome) named.add(outcome.change);
          if (outcome && !outcome.proven) unanimous = false;
        } else if (binding.kind === 'import') {
          for (const change of await importCandidates(
            importsAt.get(declaration + '\0' + head) ?? [],
            spelling,
          ))
            named.add(change);
        }
        if (named.size !== 1 || (primary && !named.has(primary.change))) unanimous = false;
        for (const change of named) alternatives.add(change);
      }
      const [change] = alternatives;
      if (!change) return;
      return unanimous && primary
        ? primary
        : { change: primary?.change ?? change, proven: false, why: 'A conditional binding' };
    };
    const resolveCall = (site: CallSite): Promise<Outcome> | Outcome => {
      let callee = site.call.childForFieldName('function');
      while (callee?.type === 'parenthesized_expression' && callee.namedChildCount === 1)
        callee = callee.firstNamedChild;
      if (!callee) return;
      // type(self)(...) and self.__class__(...) construct the enclosing class.
      let instance: Node | null | undefined;
      if (callee.type === 'call') {
        const fn = callee.childForFieldName('function');
        const args = callee.childForFieldName('arguments')?.namedChildren ?? [];
        if (
          fn?.type === 'identifier' &&
          fn.text === 'type' &&
          args.length === 1 &&
          !resolveName(site.scope, 'type')
        )
          instance = args[0];
      } else if (
        callee.type === 'attribute' &&
        callee.childForFieldName('attribute')?.text === '__class__'
      )
        instance = callee.childForFieldName('object');
      if (instance !== undefined) {
        const owner =
          instance?.type === 'identifier' && receiverOf(site.scope, instance.text, 'instance');
        return owner ? owned(owner) : undefined;
      }
      const spelling = pythonDottedName(callee);
      if (!spelling) return;
      return resolveSpelling(spelling, lexical.anchor('call', site.call), site.call, site.scope, 0);
    };
    for (const site of calls) {
      const outcome = await resolveCall(site);
      if (!outcome) continue;
      const { change } = outcome;
      if (graphTargets && !graphTargets.has(change.target.id)) continue;
      const removed = site.explicit.filter((keyword) =>
        change.stillAccepted ? !change.stillAccepted.has(keyword) : change.removed.has(keyword),
      );
      const dynamic =
        site.unpacked && (change.removed.size > 0 || change.stillAccepted !== undefined);
      if (!removed.length && !dynamic) continue;
      const line = site.call.startPosition.row + 1;
      if (!outcome.proven) {
        skip(file, `${outcome.why} at line ${line} may call ${change.target.name}`);
        continue;
      }
      if (dynamic)
        skip(file, 'Cannot verify keys supplied by ** at a call to ' + change.target.name);
      if (!removed.length) continue;
      if (change.inheritedMetaclass) {
        skip(
          file,
          `An inherited metaclass may still accept keywords removed from ${change.target.name}`,
        );
        continue;
      }
      findings.push({
        target: change.target.id,
        name: change.target.name,
        filePath: file,
        line,
        keyword: removed[0],
        ...(removed.length > 1 ? { keywords: removed } : {}),
      });
    }
  }
  return result();
}
