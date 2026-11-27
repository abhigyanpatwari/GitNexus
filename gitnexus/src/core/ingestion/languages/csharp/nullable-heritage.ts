import type { SymbolDefinition } from 'gitnexus-shared';
import { specializeNamedNullableOperand } from '../../heritage-substitutions.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { canonicalName, isCsharpReservedTypeKeyword } from './identifiers.js';

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
  if (
    constraints?.valueParameters?.includes(formal) ||
    constraints?.referenceParameters?.includes(formal)
  ) {
    return specializeNamedNullableOperand(actual);
  }
  // Other parts of a partial declaration can supply the missing constraint.
  if (constraints?.partial) return null;
  if (actual === 'string' || actual === 'object' || actual.endsWith('?')) {
    return specializeNamedNullableOperand(actual);
  }
  return actual !== 'void' && isCsharpReservedTypeKeyword(actual) ? actual : null;
}

/** Built-in reference annotations do not participate in a CLR method signature. */
export function normalizeCsharpNullableSignature(type: string): string {
  return type.replace(/(?<![\p{ID_Continue}.@])\b(string|object)\s*\?/gu, '$1');
}
