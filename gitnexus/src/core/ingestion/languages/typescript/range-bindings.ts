import type { TypeRef } from 'gitnexus-shared';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { parseMapTupleSentinel } from '../../scope-resolution/passes/compound-receiver.js';
import {
  bindsTypeParameter,
  findReceiverTypeBinding,
  lookupNameClaim,
} from '../../scope-resolution/scope/walkers.js';
import { typeApplicationArguments } from '../../utils/template-arguments.js';

// A required tuple slot with a simple type name and an optional label.
const requiredTupleElement =
  /^(?:[$_\p{ID_Start}][$\p{ID_Continue}]*\s*:\s*)?([$_\p{ID_Start}][$\p{ID_Continue}]*)$/u;

/** Bind a destructured iteration variable in the scope of its iterable's annotation. */
export const populateTsRangeBindings: ScopeResolver['populateRangeBindings'] = (files, indexes) => {
  for (const file of files) {
    for (const scope of file.scopes) {
      for (const [name, binding] of scope.typeBindings) {
        const slot = parseMapTupleSentinel(binding.rawName);
        if (!slot) continue;
        const source = findReceiverTypeBinding(scope.id, slot.rhs, indexes, {
          purpose: 'value',
          position: binding.lookupPosition,
        });
        if (!source) continue;
        const spelling = source.declaredSpelling ?? source.rawName;
        const container =
          /^(Iterable|ReadonlyArray|Array|AsyncIterable|AsyncIterableIterator|AsyncGenerator)\s*</u.exec(
            spelling,
          )?.[1];
        if (!container || (container.startsWith('Async') && !slot.asynchronous)) continue;
        const item = typeApplicationArguments(spelling)?.[0]?.replace(/^readonly\s+/, '');
        if (!item?.startsWith('[')) continue;
        const elements = typeApplicationArguments(item);
        if (!elements || elements.slice(0, slot.tupleIdx).some((type) => type.startsWith('...')))
          continue;
        const typeName = requiredTupleElement.exec(elements[slot.tupleIdx] ?? '')?.[1];
        if (!typeName) continue;
        const lookup = { purpose: 'type' as const, position: source.lookupPosition };
        if (
          bindsTypeParameter(source.declaredAtScope, container, indexes) ||
          lookupNameClaim(source.declaredAtScope, container, indexes, lookup).status !== 'absent'
        )
          continue;
        (scope.typeBindings as Map<string, TypeRef>).set(name, {
          ...binding,
          rawName: typeName,
          declaredAtScope: source.declaredAtScope,
          lookupPosition: source.lookupPosition,
          lookupPurpose: 'type',
        });
      }
    }
  }
};
