import type { SymbolDefinition } from 'gitnexus-shared';
import { specializeNamedNullableOperand } from '../../heritage-substitutions.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { canonicalName, isCsharpReservedTypeKeyword } from './identifiers.js';

import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { bindsTypeParameter, lookupNameClaim } from '../../scope-resolution/scope/walkers.js';

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
  if (constraints?.referenceParameters?.includes(formal)) {
    // This fully qualified operand identifies the same reference type in both signatures.
    // An unresolved local spelling might bind to different types in each declaration.
    if (
      /^global::(?:@?[_\p{ID_Start}][_\p{ID_Continue}]*\.)*@?[_\p{ID_Start}][_\p{ID_Continue}]*$/u.test(
        actual,
      )
    )
      return actual;
    return specializeNamedNullableOperand(actual);
  }
  if (constraints?.valueParameters?.includes(formal)) {
    return specializeNamedNullableOperand(actual);
  }
  // Other parts of a partial declaration can supply the missing constraint.
  if (constraints?.partial) return null;
  if (actual === 'string' || actual === 'object' || actual.endsWith('?')) {
    return specializeNamedNullableOperand(actual);
  }
  return actual !== 'void' && isCsharpReservedTypeKeyword(actual) ? actual : null;
}

/** Compare a reference type by its CLR identity in the declaration that wrote it. */
export const normalizeCsharpNullableSignature: NonNullable<
  ScopeResolver['normalizeNullableHeritageSignature']
> = (type, declaration) => {
  const builtin = type.replace(/(?<![\p{ID_Continue}.@:])\b(string|object)\s*\?/gu, '$1');
  if (!declaration) return builtin;
  const { scope, indexes } = declaration;
  return builtin.replace(
    /(?<![\p{ID_Continue}.@:])(@?[_\p{ID_Start}][_\p{ID_Continue}]*)(?![\p{ID_Continue}.:])(?:\s*\?)?/gu,
    (source, spelling: string) => {
      if (isCsharpReservedTypeKeyword(spelling)) return source;
      const name = canonicalName(spelling);
      if (bindsTypeParameter(scope, name, indexes)) return source;
      const claim = lookupNameClaim(scope, name, indexes, { purpose: 'type' });
      if (claim.status !== 'resolved' || !claim.bindings.length) return source;
      let identity: string | undefined;
      for (const { def } of claim.bindings) {
        // The Record label also includes record structs, whose suffix is significant.
        if ((def.type !== 'Class' && def.type !== 'Interface') || !def.qualifiedName) return source;
        const qualified =
          def.namespacePrefix && !def.qualifiedName.startsWith(def.namespacePrefix + '.')
            ? def.namespacePrefix + '.' + def.qualifiedName
            : def.qualifiedName;
        if (identity !== undefined && identity !== qualified) return source;
        identity = qualified;
      }
      return 'global::' + identity;
    },
  );
};
