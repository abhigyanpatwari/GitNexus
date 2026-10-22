/**
 * PHP namespaced-function callees (#3498 follow-up).
 *
 * `rp\make()`, `\App\Mod\make()`, `Mod\make()` and `namespace\make()` name a
 * function through a path PHP reads against the CALLING file: a leading `\`
 * anchors it at the global namespace, `namespace\` at the file's own, and any
 * other first segment goes through the file's class/namespace `use` table,
 * falling back to the file's namespace (PHP manual, "Name resolution rules").
 * The shared walkers never split that text: they hand it to
 * `ScopeResolver.resolveQualifiedCallee` / `resolveQualifiedFreeCall`, which
 * both land here, so a call's result type and its CALLS edge come from one
 * resolution.
 *
 * Functions are found by fully qualified name over every `Function` def in the
 * workspace, and only when exactly one declares that name: PHP refuses a second
 * declaration at runtime, so two defs mean conditional declarations the
 * analyzer cannot choose between. An unqualified callee is refused — the
 * shared scope-chain lookups already own it.
 */

import type {
  BindingRef,
  ParsedFile,
  ParsedImport,
  ScopeId,
  SymbolDefinition,
} from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { ParseTimeoutError, parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { logger } from '../../../logger.js';
import type { PhpSiblingInputs } from './namespace-siblings.js';
import { getPhpParser } from './query.js';

/** What PHP name resolution reads off the calling file. */
export interface PhpNameContext {
  /** The declared namespace, `''` for the global namespace. */
  readonly namespace: string;
  readonly imports: readonly ParsedImport[];
}

/** A `use` clause binding one local name (`use A\B;`, `use A\B as C;`). */
type NamedPhpImport = Extract<ParsedImport, { readonly kind: 'named' | 'alias' }>;

/** One resolution pass's view of the workspace's PHP functions. */
interface PhpFunctionIndex {
  readonly contextByFile: ReadonlyMap<string, PhpNameContext>;
  /** ASCII-case-folded fully qualified name → every `Function` def declaring it. */
  readonly functionsByFqn: ReadonlyMap<string, readonly SymbolDefinition[]>;
  /** Namespace ownership could not be recovered for these named declarations. */
  readonly unownedNames: ReadonlySet<string>;
  /** Known function identity, but no trustworthy scope for its return annotation. */
  readonly unownedProducerIds: ReadonlySet<string>;
}

/** Keyed by the pass's indexes, so concurrent or stale passes never mix. */
const indexByPass = new WeakMap<ScopeResolutionIndexes, PhpFunctionIndex>();

/** An optional absolute anchor, then backslash-separated PHP labels. */
// PHP labels allow any non-ASCII code point, including marks and symbols.
const CALLEE_PATH_RE =
  /^(\\)?((?:[A-Za-z_\u0080-\u{10FFFF}][A-Za-z0-9_\u0080-\u{10FFFF}]*\\)*[A-Za-z_\u0080-\u{10FFFF}][A-Za-z0-9_\u0080-\u{10FFFF}]*)$/u;
const IDENTIFIER_RE = /^[A-Za-z_\u0080-\u{10FFFF}][A-Za-z0-9_\u0080-\u{10FFFF}]*$/u;

// PHP's case-insensitive names fold ASCII letters only.
const asciiLowerCase = (name: string): string =>
  name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

const within = (namespace: string, path: string): string =>
  namespace === '' ? path : `${namespace}\\${path}`;

/**
 * The fully qualified name `calleeText` gives a function called from a file
 * with `context`, or `undefined` for an unqualified or malformed callee.
 * Namespace and alias names are ASCII case-insensitive in PHP; the case written is
 * kept, and the lookup folds it.
 */
export function phpFunctionFqn(calleeText: string, context: PhpNameContext): string | undefined {
  const match = CALLEE_PATH_RE.exec(calleeText.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, ''));
  if (match === null) return undefined;
  const anchor = match[1];
  const path = match[2] ?? '';
  if (anchor === '\\') return path;
  const separator = path.indexOf('\\');
  if (separator === -1) return undefined;
  // Only the class/namespace table rewrites a qualified head; `use function`
  // aliases apply to unqualified calls alone.
  const head = asciiLowerCase(path.slice(0, separator));
  if (head === 'namespace') return within(context.namespace, path.slice(separator + 1));
  const imported = context.imports.find(
    (parsedImport): parsedImport is NamedPhpImport =>
      (parsedImport.kind === 'named' || parsedImport.kind === 'alias') &&
      parsedImport.importedSymbolKind === 'type' &&
      asciiLowerCase(parsedImport.localName) === head,
  );
  return imported === undefined
    ? within(context.namespace, path)
    : `${imported.targetRaw.replace(/^\\+/, '')}${path.slice(separator)}`;
}

/**
 * Record each file's name context and index every function by fully qualified
 * name for this pass. Called once namespaces are known
 * (`populatePhpNamespaceSiblings`). Multi-namespace files contribute declarations
 * under their actual namespaces, but remain unsupported as calling contexts.
 */
export function recordPhpFunctionIndex(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
  namespaceByFile: ReadonlyMap<string, string>,
  inputs: PhpSiblingInputs,
): void {
  const contextByFile = new Map<string, PhpNameContext>();
  const functionsByFqn = new Map<string, SymbolDefinition[]>();
  const unownedNames = new Set<string>();
  const unownedProducerIds = new Set<string>();
  for (const parsed of parsedFiles) {
    if (!namespaceByFile.has(parsed.filePath)) continue;
    const multipleNamespaces =
      parsed.scopes.filter((scope) => scope.kind === 'Namespace').length > 1;
    const namespace = multipleNamespaces
      ? namespaceByFile.get(parsed.filePath)
      : singleNamespaceFromScope(parsed, inputs);
    const declarationNamespaces = multipleNamespaces
      ? functionNamespaces(parsed, inputs)
      : undefined;
    if (!multipleNamespaces && namespace !== undefined)
      contextByFile.set(parsed.filePath, { namespace, imports: parsed.parsedImports });
    for (const def of parsed.localDefs) {
      if (def.type !== 'Function') continue;
      const name = (def.qualifiedName ?? '').split('\\').at(-1) ?? '';
      // A closure bound to `$handler` is a Function def no path can name.
      if (!IDENTIFIER_RE.test(name)) continue;
      if ((multipleNamespaces && declarationNamespaces === undefined) || namespace === undefined) {
        unownedNames.add(asciiLowerCase(name));
        continue;
      }
      const declaredNamespace =
        declarationNamespaces?.get(def.nodeId) ?? (multipleNamespaces ? undefined : namespace);
      if (declaredNamespace === undefined) continue;
      const key = asciiLowerCase(within(declaredNamespace, name));
      if (multipleNamespaces) unownedProducerIds.add(def.nodeId);
      const defs = functionsByFqn.get(key);
      if (defs === undefined) functionsByFqn.set(key, [def]);
      else defs.push(def);
    }
  }
  indexByPass.set(indexes, { contextByFile, functionsByFqn, unownedNames, unownedProducerIds });
}

/** Scope anchors identify the actual header even when an uncached scanner misses it. */
function singleNamespaceFromScope(
  parsed: ParsedFile,
  inputs: PhpSiblingInputs,
): string | undefined {
  const scope = parsed.scopes.find((candidate) => candidate.kind === 'Namespace');
  if (scope === undefined) return '';
  const content = inputs.fileContents.get(parsed.filePath);
  if (content === undefined) return undefined;
  const header = content
    .split('\n')
    .slice(scope.range.startLine - 1)
    .join('\n')
    .slice(scope.range.startCol);
  const match =
    /^namespace(?:\s+([A-Za-z_\u0080-\u{10FFFF}][A-Za-z0-9_\u0080-\u{10FFFF}\\]*))?\s*[;{]/iu.exec(
      header,
    );
  return match === null ? undefined : (match[1] ?? '');
}

/** Only multi-namespace files need declaration-specific source ownership. */
function functionNamespaces(
  parsed: ParsedFile,
  inputs: PhpSiblingInputs,
): ReadonlyMap<string, string> | undefined {
  const content = inputs.fileContents.get(parsed.filePath);
  const result = new Map<string, string>();
  if (content === undefined) return undefined;
  const cached = inputs.treeCache?.get(parsed.filePath);
  let tree: ReturnType<typeof parseSourceSafe>;
  try {
    tree = (cached ??
      parseSourceSafe(
        getPhpParser(),
        content,
        undefined,
        undefined,
        parsed.filePath,
      )) as ReturnType<typeof parseSourceSafe>;
  } catch (error) {
    if (!(error instanceof ParseTimeoutError)) throw error;
    logger.warn(
      { file: parsed.filePath },
      'PHP namespace parse timed out; named functions remain ambiguous',
    );
    return undefined;
  }
  const declarations = tree.rootNode.namedChildren.filter(
    (node) => node.type === 'namespace_definition',
  );
  const regions = declarations.map((node, index) => {
    const end =
      node.childForFieldName('body') === null
        ? (declarations[index + 1]?.startPosition ?? tree.rootNode.endPosition)
        : node.endPosition;
    return {
      namespace: node.childForFieldName('name')?.text ?? '',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
      endLine: end.row + 1,
      endColumn: end.column,
    };
  });
  for (const def of parsed.localDefs) {
    if (def.type !== 'Function') continue;
    const at = def.declarationRange ?? def.nameRange;
    if (at === undefined) continue;
    let low = 0;
    let high = regions.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const region = regions[mid]!;
      if (
        region.line < at.startLine ||
        (region.line === at.startLine && region.column <= at.startCol)
      )
        low = mid + 1;
      else high = mid;
    }
    const region = regions[low - 1];
    if (
      region !== undefined &&
      (at.startLine < region.endLine ||
        (at.startLine === region.endLine && at.startCol < region.endColumn))
    )
      result.set(def.nodeId, region.namespace);
  }
  return result;
}

/**
 * `ScopeResolver.resolveQualifiedCallee`: the function a qualified callee path
 * names from `inScope`'s file (`rp\make` in `$x = rp\make()` or
 * `rp\make()->m()`), or `undefined` when the text is unqualified, names no
 * workspace function, or names more than one.
 */
export function resolvePhpQualifiedCallee(
  calleeText: string,
  inScope: ScopeId,
  scopes: ScopeResolutionIndexes,
  argumentsText?: string,
): SymbolDefinition | undefined {
  // First-class callable creation is a Closure, not the function's result.
  if (argumentsText !== undefined && isCallableCreationArguments(argumentsText)) return undefined;
  // Asked about every name the shared sites fail to resolve: refuse cheaply.
  if (!calleeText.includes('\\')) return undefined;
  // Type bindings mark an invoked function with (); reference sites carry
  // only the path. Both resolve through the same function namespace.
  if (calleeText.endsWith('()')) calleeText = calleeText.slice(0, -2);
  const index = indexByPass.get(scopes);
  const filePath = scopes.scopeTree.getScope(inScope)?.filePath;
  if (index === undefined || filePath === undefined) return undefined;
  const context = index.contextByFile.get(filePath);
  if (context === undefined) return undefined;
  const fqn = phpFunctionFqn(calleeText, context);
  return fqn === undefined ? undefined : uniqueFunction(fqn, index);
}

/** A sole placeholder token, allowing comments and whitespace around it. */
function isCallableCreationArguments(text: string): boolean {
  let cursor = 0;
  let placeholder = false;
  while (cursor < text.length) {
    if (/\s/.test(text[cursor]!)) cursor++;
    else if (text.startsWith('/*', cursor)) {
      const end = text.indexOf('*/', cursor + 2);
      if (end < 0) return false;
      cursor = end + 2;
    } else if (text.startsWith('//', cursor) || text[cursor] === '#') {
      while (cursor < text.length && text[cursor] !== '\r' && text[cursor] !== '\n') cursor++;
    } else if (!placeholder && text.startsWith('...', cursor)) {
      placeholder = true;
      cursor += 3;
    } else return false;
  }
  return placeholder;
}

/** The one function declaring `fqn`, or `undefined` when none or several do. */
function uniqueFunction(fqn: string, index: PhpFunctionIndex): SymbolDefinition | undefined {
  if (index.unownedNames.has(asciiLowerCase(fqn.slice(fqn.lastIndexOf('\\') + 1))))
    return undefined;
  const defs = index.functionsByFqn.get(asciiLowerCase(fqn));
  const def = defs?.length === 1 ? defs[0] : undefined;
  return def !== undefined && !index.unownedProducerIds.has(def.nodeId) ? def : undefined;
}

/**
 * Bind a `use function A\f;` that import resolution left without a binding to
 * the one workspace function named `A\f`. Import resolution finds a function
 * only through a PSR-4 directory or a file named after it, so one loaded
 * through composer `autoload.files`, or declared in a project with no
 * `composer.json`, binds nothing, and `$x = f()` has no return type to read.
 * The fully qualified name is the function's identity, so this guesses
 * nothing. A name the importing scope already binds is left alone: a resolved
 * import or a local declaration is never second-guessed.
 */
export function bindPhpUseFunctionImports(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
): void {
  const index = indexByPass.get(indexes);
  if (index === undefined) return;
  const augmentations = indexes.bindingAugmentations as Map<ScopeId, Map<string, BindingRef[]>>;
  for (const parsed of parsedFiles) {
    if (!index.contextByFile.has(parsed.filePath)) continue;
    for (const parsedImport of parsed.parsedImports) {
      if (parsedImport.kind !== 'named' && parsedImport.kind !== 'alias') continue;
      if (parsedImport.importedSymbolKind !== 'function') continue;
      const def = uniqueFunction(parsedImport.targetRaw.replace(/^\\+/, ''), index);
      if (def === undefined) continue;
      const name = parsedImport.localName;
      // Finalize attaches PHP imports, and binds them, at the module scope.
      const scopeId = parsed.moduleScope;
      const via = indexes.imports.get(scopeId)?.find((edge) => edge.localName === name);
      if (via === undefined) continue;
      const bound =
        (indexes.scopeTree.getScope(scopeId)?.bindings.get(name)?.length ?? 0) +
        (indexes.bindings.get(scopeId)?.get(name)?.length ?? 0) +
        (augmentations.get(scopeId)?.get(name)?.length ?? 0);
      if (bound > 0) continue;
      let scopeBindings = augmentations.get(scopeId);
      if (scopeBindings === undefined) {
        scopeBindings = new Map();
        augmentations.set(scopeId, scopeBindings);
      }
      scopeBindings.set(name, [{ def, origin: 'import', via }]);
    }
  }
}

/** `ScopeResolver.resolveQualifiedFreeCall`: the same resolution, for the
 *  call site the qualified callee itself mints. That site is NAMED by its
 *  whole path (query.ts), so the simple-name tiers this hook falls through to
 *  find nothing: a refusal here leaves the call unresolved, never bound to a
 *  same-named function elsewhere. */
export function resolvePhpQualifiedFreeCall(
  site: { readonly rawQualifiedName?: string; readonly inScope: ScopeId },
  _callerParsed: ParsedFile,
  scopes: ScopeResolutionIndexes,
): SymbolDefinition | undefined {
  return site.rawQualifiedName === undefined
    ? undefined
    : resolvePhpQualifiedCallee(site.rawQualifiedName, site.inScope, scopes);
}
