import { makeScopeId, type SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { specializeNamedNullableOperand } from '../../heritage-substitutions.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { canonicalName, isCsharpReservedTypeKeyword } from './identifiers.js';

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

/** Only a value constraint turns the declaration's T? into System.Nullable<T>. */
export function csharpNullableConstraints(owner: SyntaxNode): NullableConstraints | undefined {
  const constraints: NullableConstraints = {};
  for (const child of owner.namedChildren) {
    if (child.type === 'modifier' && child.text === 'partial') constraints.partial = true;
    if (child.type !== 'type_parameter_constraints_clause') continue;
    const name = child.namedChildren.find((node) => node.type === 'identifier');
    if (!name) continue;
    for (const constraint of child.namedChildren) {
      if (constraint.type !== 'type_parameter_constraint') continue;
      const keyword = constraint.firstChild?.type;
      if (keyword === 'struct' || keyword === 'unmanaged') {
        (constraints.valueParameters ??= []).push(canonicalName(name.text));
      } else if (keyword === 'class') {
        (constraints.referenceParameters ??= []).push(canonicalName(name.text));
      }
    }
  }
  return Object.keys(constraints).length ? constraints : undefined;
}

export function specializeCsharpNullableFormal(
  owner: SymbolDefinition,
  formal: string,
  actual: string,
): string | null {
  const constraints = owner.templateConstraints as NullableConstraints | undefined;
  if (/\]\s*\??$/u.test(actual)) {
    // Every array is a reference type, even when its element is a nullable value.
    if (constraints?.valueParameters?.includes(formal)) return null;
    return (
      renderCsharpHeritageType(
        actual,
        (name) => (isStableCsharpTypeName(name) ? { name } : undefined),
        true,
      ) ?? null
    );
  }
  if (actual.includes('<')) {
    const value = constraints?.valueParameters?.includes(formal);
    const reference = constraints?.referenceParameters?.includes(formal);
    if (!value && !reference) return null;
    const stable = renderCsharpHeritageType(actual, (name) =>
      isStableCsharpTypeName(name) ? { name } : undefined,
    );
    if (!stable) return null;
    // The formal's constraint determines the meaning of its outer nullable marker.
    if (reference) return stable.replace(/\?$/u, '');
    return stable.endsWith('?') ? stable : stable + '?';
  }
  const reference = constraints?.referenceParameters?.includes(formal);
  const value = constraints?.valueParameters?.includes(formal);
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

/** Compare a reference type by its CLR identity in the declaration that wrote it. */
export const normalizeCsharpNullableSignature: NonNullable<
  ScopeResolver['normalizeNullableHeritageSignature']
> = (type, declaration) => {
  const builtin = type.replace(/(?<![\p{ID_Continue}.@:])\b(string|object)\s*\?/gu, '$1');
  if (!declaration) {
    const mode = csharpParameterMode.exec(builtin)?.[0] ?? '';
    const operand = builtin.slice(mode.length);
    const composite =
      (operand.includes('[') || operand.includes('(')) &&
      renderCsharpHeritageType(operand, (name) =>
        isStableCsharpTypeName(name) ? { name } : undefined,
      );
    return composite ? mode + composite : builtin;
  }
  const mode = csharpParameterMode.exec(builtin)?.[0] ?? '';
  const operand = builtin.slice(mode.length);
  const { scope, indexes } = declaration;
  const resolveName = (spelling: string, includeValues: boolean): NominalName | undefined => {
    if (isCsharpReservedTypeKeyword(spelling)) {
      return { name: spelling, reference: spelling === 'string' || spelling === 'object' };
    }
    const rooted = spelling.startsWith('global::');
    const path = rooted ? spelling.slice('global::'.length) : spelling;
    const dot = path.indexOf('.');
    if (dot >= 0) {
      let absolute = path;
      if (!rooted) {
        const head = canonicalName(path.slice(0, dot));
        if (bindsTypeParameter(scope, head, indexes)) return undefined;
        const claim = lookupNameClaim(scope, head, indexes, { purpose: 'type' });
        if (claim.status !== 'resolved' || !claim.bindings.length) return undefined;
        // The first component may be a file-local namespace alias. All selected
        // bindings must agree on the namespace before its members can be used.
        let namespace: string | undefined;
        for (const { def } of claim.bindings) {
          if (def.type !== 'Namespace') return undefined;
          const candidate = declaringNamespace(def, indexes);
          if (!candidate || (namespace && namespace !== candidate)) return undefined;
          namespace = candidate;
        }
        absolute = namespace + path.slice(dot);
      }
      // C# keeps simple type names in this index. Select only declarations
      // whose complete namespace and type match the written path.
      const tail = absolute.slice(absolute.lastIndexOf('.') + 1);
      let identity: NominalName | undefined;
      for (const id of indexes.qualifiedNames.get(tail)) {
        const def = indexes.defs.get(id);
        const candidate = def && nominalIdentity(def, includeValues, indexes);
        if (!candidate || candidate.name !== 'global::' + absolute) continue;
        if (identity && identity.reference !== candidate.reference) return undefined;
        identity = candidate;
      }
      return identity;
    }
    const name = canonicalName(path);
    if (bindsTypeParameter(scope, name, indexes)) return undefined;
    const claim = lookupNameClaim(scope, name, indexes, { purpose: 'type' });
    if (claim.status !== 'resolved' || !claim.bindings.length) return undefined;
    if (/[[(]/u.test(operand)) {
      // Import edges identify a target file and a simple exported name. A file
      // declaring that name in two namespaces cannot establish a bare alias's
      // target inside this structural type by choosing the first declaration.
      for (const imported of claim.imports) {
        if (imported.kind !== 'alias') continue;
        let target: string | undefined;
        for (const id of indexes.qualifiedNames.get(imported.targetExportedName)) {
          const def = indexes.defs.get(id);
          if (def?.filePath !== imported.targetFile) continue;
          const named = nominalIdentity(def, true, indexes)?.name;
          if (!named) continue;
          if (target && target !== named) return undefined;
          target = named;
        }
      }
    }
    let identity: NominalName | undefined;
    for (const { def } of claim.bindings) {
      const candidate = nominalIdentity(def, includeValues, indexes);
      if (!candidate || (rooted && candidate.name !== spelling)) return undefined;
      if (
        identity &&
        (identity.name !== candidate.name || identity.reference !== candidate.reference)
      )
        return undefined;
      identity = candidate;
    }
    return identity;
  };
  const scalar = csharpScalarType(operand);
  if (scalar) {
    const resolved = resolveName(scalar.name, true);
    if (resolved) return mode + resolved.name + (scalar.nullable && !resolved.reference ? '?' : '');
    if (
      scalar.name.startsWith('global::') ||
      bindsTypeParameter(scope, canonicalName(scalar.name), indexes)
    )
      return builtin;
    // Keep the ordinary spelling comparison for types outside the index. A
    // claimed name whose identity could not be established (e.g. an unresolved
    // alias) must not match the same spelling in another declaration.
    const head = canonicalName(scalar.name.split('.')[0]!);
    return lookupNameClaim(scope, head, indexes, { purpose: 'type' }).status === 'absent'
      ? builtin
      : null;
  }
  if (/[<[(]/u.test(operand)) {
    let grounded = true;
    const constructed = renderCsharpHeritageType(
      operand,
      (name) => {
        const resolved = resolveName(name, true);
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
