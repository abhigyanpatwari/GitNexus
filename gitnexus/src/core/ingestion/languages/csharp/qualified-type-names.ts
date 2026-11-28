/**
 * Tag C# file-level type defs with their enclosing-namespace path on the
 * sidecar `namespacePrefix` field — WITHOUT touching `qualifiedName` (mutating
 * it corrupts simple-name heritage / base resolution; #2046 regression).
 *
 * `tagNamespacePrefixes` (shared) only reaches defs whose scope chain includes
 * a Namespace scope. C# file-scoped `namespace X;` gives the Namespace scope a
 * 1-line range, so top-level types land under the Module scope and are missed.
 * This pass covers both block- and file-scoped namespaces so the qualified
 * constructor resolver can break a same-tail collision (`new B.Foo()` with both
 * `A.Foo` and `B.Foo`) by matching the explicit qualifier against the sidecar.
 */
import { renderCsharpHeritageType } from './heritage-type-shape.js';
import { isCsharpReservedTypeKeyword } from './identifiers.js';
import type { ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import { isClassLike } from '../../scope-resolution/scope/walkers.js';

function isTypeDef(def: SymbolDefinition): boolean {
  return isClassLike(def.type) || def.type === 'Enum';
}

export function populateCsharpNamespacePrefixes(parsed: ParsedFile): void {
  const scopesById = new Map<ScopeId, ParsedFile['scopes'][number]>();
  for (const scope of parsed.scopes) scopesById.set(scope.id, scope);

  // The file's declared namespace (file-scoped `namespace X;`). First Namespace
  // scope's own def qualifiedName; undefined when the file is namespace-free.
  const fileNamespace = ((): string | undefined => {
    for (const scope of parsed.scopes) {
      if (scope.kind !== 'Namespace') continue;
      const nsDef = scope.ownedDefs.find((d) => d.type === 'Namespace');
      const q = nsDef?.qualifiedName;
      if (q !== undefined && q.length > 0) return q;
    }
    return undefined;
  })();

  // Enclosing namespace path for a scope: nearest ancestor Namespace scope's
  // full qualifiedName, else the file-scoped namespace (Module-parented types).
  const namespaceOf = (scope: ParsedFile['scopes'][number]): string | undefined => {
    let parentId = scope.parent;
    while (parentId !== null) {
      const parent = scopesById.get(parentId);
      if (parent === undefined) break;
      if (parent.kind === 'Namespace') {
        const nsDef = parent.ownedDefs.find((d) => d.type === 'Namespace');
        const q = nsDef?.qualifiedName;
        if (q !== undefined && q.length > 0) return q;
      }
      if (parent.kind === 'Module') return fileNamespace;
      parentId = parent.parent;
    }
    return fileNamespace;
  };

  for (const scope of parsed.scopes) {
    if (scope.kind !== 'Class') continue;
    const prefix = namespaceOf(scope);
    if (prefix === undefined || prefix.length === 0) continue;
    for (const def of scope.ownedDefs) {
      if (!isTypeDef(def)) continue;
      if (def.namespacePrefix !== undefined) continue;
      const q = def.qualifiedName;
      if (q === prefix || (q !== undefined && q.startsWith(`${prefix}.`))) continue;
      def.namespacePrefix = prefix;
    }
  }
}

const qualifiedNames =
  /[_\p{ID_Start}][\p{ID_Continue}]*(?:\s*(?:\.|::)\s*[_\p{ID_Start}][\p{ID_Continue}]*)*/gu;
const nullableQualifiedNames = new RegExp(qualifiedNames.source + String.raw`(?:\s*\?)?`, 'gu');

export function isStableCsharpTypeName(name: string): boolean {
  return /^global\s*::/u.test(name) || isCsharpReservedTypeKeyword(name);
}

// A rooted constructor can still contain a file-local alias. Check both the
// original type and each argument before comparing names across declarations.
function stableType(
  type: string,
  bindings?: ReadonlyMap<string, string | null>,
  shadowed?: ReadonlySet<string>,
): boolean {
  // Check complete type operands instead of guessing what a '?' annotates
  // from its preceding character. Tuple element labels and aliases cannot bind formals.
  return (
    renderCsharpHeritageType(type, (name) => {
      if (isStableCsharpTypeName(name)) return { name };
      const actual = shadowed?.has(name) ? undefined : bindings?.get(name);
      return actual !== undefined && (actual === null || stableType(actual)) ? { name } : undefined;
    }) !== undefined
  );
}

/** In a global-qualified signature, keep every qualified name as one token. */
export function csharpQualifiedHeritageTypePattern(
  type: string,
  bindings: ReadonlyMap<string, string | null>,
  shadowed?: ReadonlySet<string>,
): RegExp | undefined {
  return type.includes('::') && stableType(type, bindings, shadowed)
    ? nullableQualifiedNames
    : undefined;
}
