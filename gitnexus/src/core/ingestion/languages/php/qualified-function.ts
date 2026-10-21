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

import type { ParsedFile, ParsedImport, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';

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
  /** Lower-cased fully qualified name → every `Function` def declaring it. */
  readonly functionsByFqn: ReadonlyMap<string, readonly SymbolDefinition[]>;
}

/** Keyed by the pass's indexes, so concurrent or stale passes never mix. */
const indexByPass = new WeakMap<ScopeResolutionIndexes, PhpFunctionIndex>();

/** An optional `\` or `namespace\` anchor, then backslash-separated names. */
const CALLEE_PATH_RE = /^(\\|namespace\\)?((?:[A-Za-z_]\w*\\)*[A-Za-z_]\w*)$/i;
const IDENTIFIER_RE = /^[A-Za-z_]\w*$/;

const within = (namespace: string, path: string): string =>
  namespace === '' ? path : `${namespace}\\${path}`;

/**
 * The fully qualified name `calleeText` gives a function called from a file
 * with `context`, or `undefined` for an unqualified or malformed callee.
 * Namespace and alias names are case-insensitive in PHP; the case written is
 * kept, and the lookup folds it.
 */
export function phpFunctionFqn(calleeText: string, context: PhpNameContext): string | undefined {
  const match = CALLEE_PATH_RE.exec(calleeText.trim());
  if (match === null) return undefined;
  const anchor = match[1];
  const path = match[2] ?? '';
  if (anchor === '\\') return path;
  if (anchor !== undefined) return within(context.namespace, path);
  const separator = path.indexOf('\\');
  if (separator === -1) return undefined;
  // Only the class/namespace table rewrites a qualified head; `use function`
  // aliases apply to unqualified calls alone.
  const head = path.slice(0, separator).toLowerCase();
  const imported = context.imports.find(
    (parsedImport): parsedImport is NamedPhpImport =>
      (parsedImport.kind === 'named' || parsedImport.kind === 'alias') &&
      parsedImport.importedSymbolKind === 'type' &&
      parsedImport.localName.toLowerCase() === head,
  );
  return imported === undefined
    ? within(context.namespace, path)
    : `${imported.targetRaw.replace(/^\\+/, '')}${path.slice(separator)}`;
}

/**
 * Record each file's name context and index every function by fully qualified
 * name for this pass. Called once namespaces are known
 * (`populatePhpNamespaceSiblings`); a file whose namespace is unknown, or that
 * declares several namespaces (the single namespace recorded for it would be
 * wrong for some of its declarations), contributes nothing and resolves nothing.
 */
export function recordPhpFunctionIndex(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
  namespaceByFile: ReadonlyMap<string, string>,
): void {
  const contextByFile = new Map<string, PhpNameContext>();
  const functionsByFqn = new Map<string, SymbolDefinition[]>();
  for (const parsed of parsedFiles) {
    const namespace = namespaceByFile.get(parsed.filePath);
    if (namespace === undefined) continue;
    if (parsed.scopes.filter((scope) => scope.kind === 'Namespace').length > 1) continue;
    contextByFile.set(parsed.filePath, { namespace, imports: parsed.parsedImports });
    for (const def of parsed.localDefs) {
      if (def.type !== 'Function') continue;
      const name = (def.qualifiedName ?? '').split('\\').at(-1) ?? '';
      // A closure bound to `$handler` is a Function def no path can name.
      if (!IDENTIFIER_RE.test(name)) continue;
      const key = within(namespace, name).toLowerCase();
      const defs = functionsByFqn.get(key);
      if (defs === undefined) functionsByFqn.set(key, [def]);
      else defs.push(def);
    }
  }
  indexByPass.set(indexes, { contextByFile, functionsByFqn });
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
): SymbolDefinition | undefined {
  // Asked about every name the shared sites fail to resolve: refuse cheaply.
  if (!calleeText.includes('\\')) return undefined;
  const index = indexByPass.get(scopes);
  const filePath = scopes.scopeTree.getScope(inScope)?.filePath;
  if (index === undefined || filePath === undefined) return undefined;
  const context = index.contextByFile.get(filePath);
  if (context === undefined) return undefined;
  const fqn = phpFunctionFqn(calleeText, context);
  const defs = fqn === undefined ? undefined : index.functionsByFqn.get(fqn.toLowerCase());
  return defs?.length === 1 ? defs[0] : undefined;
}

/** `ScopeResolver.resolveQualifiedFreeCall`: the same resolution, for the
 *  call site the qualified callee itself mints. */
export function resolvePhpQualifiedFreeCall(
  site: { readonly rawQualifiedName?: string; readonly inScope: ScopeId },
  _callerParsed: ParsedFile,
  scopes: ScopeResolutionIndexes,
): SymbolDefinition | undefined {
  return site.rawQualifiedName === undefined
    ? undefined
    : resolvePhpQualifiedCallee(site.rawQualifiedName, site.inScope, scopes);
}
