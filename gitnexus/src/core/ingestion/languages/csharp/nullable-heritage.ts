import {
  makeScopeId,
  type BindingRef,
  type ImportEdge,
  type ScopeId,
  type SymbolDefinition,
} from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { specializeNamedNullableOperand } from '../../heritage-substitutions.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { canonicalName, csharpSystemKeyword, isCsharpReservedTypeKeyword } from './identifiers.js';

import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { bindsTypeParameter, lookupNameClaim } from '../../scope-resolution/scope/walkers.js';

import { isStableCsharpTypeName } from './qualified-type-names.js';
import {
  csharpParameterMode,
  csharpScalarType,
  renderCsharpHeritageType,
  type NominalName,
} from './heritage-type-shape.js';

export { csharpParameterMode } from './heritage-type-shape.js';

interface NullableConstraints {
  valueParameters?: string[];
  referenceParameters?: string[];
  partial?: true;
}

function readConstraintClause(clause: SyntaxNode, constraints: NullableConstraints): void {
  const children = clause.namedChildren;
  const name = children.find((node) => node.type === 'identifier');
  if (!name) return;
  for (const constraint of children) {
    if (constraint.type !== 'type_parameter_constraint') continue;
    const keyword = constraint.firstChild?.type;
    if (keyword === 'struct' || keyword === 'unmanaged') {
      constraints.valueParameters ??= [];
      constraints.valueParameters.push(canonicalName(name.text));
    } else if (keyword === 'class') {
      constraints.referenceParameters ??= [];
      constraints.referenceParameters.push(canonicalName(name.text));
    }
  }
}

/** Only a value constraint turns the declaration's T? into System.Nullable<T>. */
export function csharpNullableConstraints(owner: SyntaxNode): NullableConstraints | undefined {
  const constraints: NullableConstraints = {};
  for (const child of owner.namedChildren) {
    if (child.type === 'modifier' && child.text === 'partial') constraints.partial = true;
    if (child.type === 'type_parameter_constraints_clause')
      readConstraintClause(child, constraints);
  }
  return Object.keys(constraints).length ? constraints : undefined;
}

function stableIdentity(name: string): NominalName | undefined {
  return isStableCsharpTypeName(name) ? { name } : undefined;
}

function specializeConstructedFormal(
  actual: string,
  value: boolean | undefined,
  reference: boolean | undefined,
): string | null {
  if (!value && !reference) return null;
  const stable = renderCsharpHeritageType(actual, stableIdentity);
  if (!stable) return null;
  // The formal's constraint determines the meaning of its outer nullable marker.
  if (reference) return stable.replace(/\?$/u, '');
  return stable.endsWith('?') ? stable : stable + '?';
}

export function specializeCsharpNullableFormal(
  owner: SymbolDefinition,
  formal: string,
  actual: string,
): string | null {
  const constraints = owner.templateConstraints as NullableConstraints | undefined;
  const value = constraints?.valueParameters?.includes(formal);
  if (/\]\s*\??$/u.test(actual)) {
    // Every array is a reference type, even when its element is a nullable value.
    if (value) return null;
    return renderCsharpHeritageType(actual, stableIdentity, true) ?? null;
  }
  const reference = constraints?.referenceParameters?.includes(formal);
  if (actual.includes('<')) return specializeConstructedFormal(actual, value, reference);
  if (reference || value) {
    const rooted = actual.startsWith('global::') && csharpScalarType(actual);
    if (rooted) return reference ? rooted.name : rooted.name + '?';
    return specializeNamedNullableOperand(actual);
  }
  // Other parts of a partial declaration can supply the missing constraint.
  if (constraints?.partial) return null;
  if (actual === 'string' || actual === 'object' || actual.endsWith('?')) {
    return specializeNamedNullableOperand(actual);
  }
  return actual !== 'void' && isCsharpReservedTypeKeyword(actual) ? actual : null;
}

// The provider's namespace lookup tiers retain the complete declaring namespace,
// including nested blocks and file-scoped namespaces.
function declaringNamespace(
  def: SymbolDefinition,
  indexes: ScopeResolutionIndexes,
): string | undefined {
  if (!def.declarationRange) return undefined;
  const id = makeScopeId({
    filePath: def.filePath,
    range: def.declarationRange,
    kind: def.type === 'Namespace' ? 'Namespace' : 'Class',
  });
  if (def.type === 'Namespace') return indexes.namespaceLookupTiersByScope?.get(id)?.[0]?.[0];
  for (const parent of indexes.scopeTree.getAncestors(id)) {
    const tier = indexes.namespaceLookupTiersByScope?.get(parent);
    if (tier) return tier[0]?.[0];
  }
  return undefined;
}

function nominalIdentity(
  def: SymbolDefinition,
  includeValues: boolean,
  indexes: ScopeResolutionIndexes,
): NominalName | undefined {
  // The Record label also includes record structs.
  const reference = def.type === 'Class' || def.type === 'Interface';
  if (
    (!reference && !(includeValues && (def.type === 'Struct' || def.type === 'Enum'))) ||
    !def.qualifiedName
  )
    return undefined;
  const namespace = declaringNamespace(def, indexes) ?? def.namespacePrefix;
  const qualified =
    namespace && !def.qualifiedName.startsWith(namespace + '.')
      ? namespace + '.' + def.qualifiedName
      : def.qualifiedName;
  return { name: 'global::' + qualified, reference };
}

function keywordIdentity(name: string): NominalName {
  return { name, reference: name === 'string' || name === 'object' };
}

interface SignatureScope {
  scope: ScopeId;
  indexes: ScopeResolutionIndexes;
}

function absoluteNamespacePath(
  path: string,
  dot: number,
  { scope, indexes }: SignatureScope,
): string | undefined {
  const head = canonicalName(path.slice(0, dot));
  if (bindsTypeParameter(scope, head, indexes)) return undefined;
  const claim = lookupNameClaim(scope, head, indexes, { purpose: 'type' });
  // External framework namespaces need not be part of the indexed sources.
  if (claim.status === 'absent' && head === 'System') return path;
  if (claim.status !== 'resolved') return undefined;
  // Every binding of a file-local namespace alias must name the same namespace.
  let namespace: string | undefined;
  for (const { def } of claim.bindings) {
    if (def.type !== 'Namespace') return undefined;
    const candidate = declaringNamespace(def, indexes);
    if (!candidate || (namespace && namespace !== candidate)) return undefined;
    namespace = candidate;
  }
  return namespace && namespace + path.slice(dot);
}

function frameworkIdentity(
  absolute: string,
  keyword: string | undefined,
  arity: number,
): NominalName | undefined {
  if (arity === 0 && keyword && isCsharpReservedTypeKeyword(keyword))
    return keywordIdentity(keyword);
  if (absolute === 'System.ValueTuple' && arity >= 1 && arity <= 8)
    return { name: 'global::' + absolute, reference: false, projection: 'tuple' };
  if (absolute === 'System.Nullable' && arity === 1)
    return { name: 'global::' + absolute, reference: false, projection: 'nullable' };
  return undefined;
}

function qualifiedIdentity(
  absolute: string,
  includeValues: boolean,
  arity: number,
  indexes: ScopeResolutionIndexes,
): NominalName | undefined {
  // The index keys C# types by simple name. Match the complete namespace and type.
  const tail = absolute.slice(absolute.lastIndexOf('.') + 1);
  const keyword = csharpSystemKeyword(absolute);
  const projected = absolute === 'System.ValueTuple' || absolute === 'System.Nullable';
  let identity: NominalName | undefined;
  for (const id of indexes.qualifiedNames.get(tail)) {
    const def = indexes.defs.get(id);
    if ((projected || keyword) && (def?.typeParameters?.length ?? 0) !== arity) continue;
    const candidate = def && nominalIdentity(def, includeValues, indexes);
    if (candidate?.name !== 'global::' + absolute) continue;
    if (identity && identity.reference !== candidate.reference) return undefined;
    identity = candidate;
  }
  if (!identity) return frameworkIdentity(absolute, keyword, arity);
  // Tuple syntax may use a source-defined ValueTuple struct. Predefined keyword
  // aliases and Nullable<T> denote types from the runtime assembly.
  if (absolute === 'System.ValueTuple' && identity.reference === false)
    return { ...identity, projection: 'tuple' };
  return identity;
}

function ambiguousTypeAlias(imported: ImportEdge, indexes: ScopeResolutionIndexes): boolean {
  if (imported.kind !== 'alias') return false;
  // An alias records its target file and simple exported name. Several qualified
  // declarations with that name in the file leave a structural operand ambiguous.
  let target: string | undefined;
  for (const id of indexes.qualifiedNames.get(imported.targetExportedName)) {
    const def = indexes.defs.get(id);
    if (def?.filePath !== imported.targetFile) continue;
    const named = nominalIdentity(def, true, indexes)?.name;
    if (!named) continue;
    if (target && target !== named) return true;
    target = named;
  }
  return false;
}

function bindingIdentity(
  bindings: readonly BindingRef[],
  includeValues: boolean,
  indexes: ScopeResolutionIndexes,
  rootedName: string | undefined,
): NominalName | undefined {
  let identity: NominalName | undefined;
  for (const { def } of bindings) {
    const candidate = nominalIdentity(def, includeValues, indexes);
    if (!candidate || (rootedName && candidate.name !== rootedName)) return undefined;
    if (
      identity &&
      (identity.name !== candidate.name || identity.reference !== candidate.reference)
    )
      return undefined;
    identity = candidate;
  }
  return identity;
}

function normalizeScalarSignature(
  builtin: string,
  mode: string,
  scalar: NonNullable<ReturnType<typeof csharpScalarType>>,
  resolved: NominalName | undefined,
  { scope, indexes }: SignatureScope,
): string | null {
  if (resolved) return mode + resolved.name + (scalar.nullable && !resolved.reference ? '?' : '');
  if (
    scalar.name.startsWith('global::') ||
    bindsTypeParameter(scope, canonicalName(scalar.name), indexes)
  )
    return builtin;
  // An unclaimed external type retains its spelling. A claimed name whose
  // identity is unresolved cannot match the same spelling in another declaration.
  const head = canonicalName(scalar.name.split('.', 1)[0]);
  return lookupNameClaim(scope, head, indexes, { purpose: 'type' }).status === 'absent'
    ? builtin
    : null;
}

/** Compare a reference type by its CLR identity in the declaration that wrote it. */
export const normalizeCsharpNullableSignature: NonNullable<
  ScopeResolver['normalizeNullableHeritageSignature']
> = (type, declaration) => {
  const builtin = type.replace(/(?<![\p{ID_Continue}.@:])\b(string|object)\s*\?/gu, '$1');
  const mode = csharpParameterMode.exec(builtin)?.[0] ?? '';
  const operand = builtin.slice(mode.length);
  if (!declaration) {
    const composite =
      (operand.includes('[') || operand.includes('(')) &&
      renderCsharpHeritageType(operand, stableIdentity);
    return composite ? mode + composite : builtin;
  }
  const { scope, indexes } = declaration;
  const resolveName = (
    spelling: string,
    includeValues: boolean,
    arity = 0,
  ): NominalName | undefined => {
    if (isCsharpReservedTypeKeyword(spelling)) return keywordIdentity(spelling);
    const rooted = spelling.startsWith('global::');
    const path = rooted ? spelling.slice('global::'.length) : spelling;
    const dot = path.indexOf('.');
    if (dot >= 0) {
      const absolute = rooted ? path : absoluteNamespacePath(path, dot, declaration);
      return absolute ? qualifiedIdentity(absolute, includeValues, arity, indexes) : undefined;
    }
    const name = canonicalName(path);
    if (bindsTypeParameter(scope, name, indexes)) return undefined;
    const claim = lookupNameClaim(scope, name, indexes, { purpose: 'type' });
    if (claim.status !== 'resolved' || !claim.bindings.length) return undefined;
    if (/[[(]/u.test(operand) && claim.imports.some((edge) => ambiguousTypeAlias(edge, indexes)))
      return undefined;
    return bindingIdentity(claim.bindings, includeValues, indexes, rooted ? spelling : undefined);
  };
  const scalar = csharpScalarType(operand);
  if (scalar)
    return normalizeScalarSignature(
      builtin,
      mode,
      scalar,
      resolveName(scalar.name, true),
      declaration,
    );
  if (/[<[(]/u.test(operand)) {
    let grounded = true;
    const constructed = renderCsharpHeritageType(
      operand,
      (name, arity) => {
        const resolved = resolveName(name, true, arity);
        if (resolved) return resolved;
        if (
          !name.startsWith('global::') &&
          !bindsTypeParameter(scope, canonicalName(name), indexes)
        ) {
          grounded = false;
        }
        return { name };
      },
      true,
    );
    if (constructed) return grounded ? mode + constructed : null;
  }
  return builtin.replace(
    /(?<![\p{ID_Continue}.@:])(@?[_\p{ID_Start}][_\p{ID_Continue}]*)(?![\p{ID_Continue}.:])(?:\s*\?)?/gu,
    (source, spelling: string) => {
      if (isCsharpReservedTypeKeyword(spelling)) return source;
      return resolveName(spelling, false)?.name ?? source;
    },
  );
};
