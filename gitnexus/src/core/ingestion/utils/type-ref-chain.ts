import type { TypeRef } from 'gitnexus-shared';

/**
 * One chain step: the binding takes the type the step reached, but keeps its
 * own written spelling when it has one. A spelling is evidence about THIS
 * binding — `member models.User`, normalized to `User`, can land on a sibling
 * field named `User` whose spelling is `api.User`, and a consumer reading the
 * spelling (a qualified lookup, an index step) must still see `models.User`.
 */
export function followedStep(start: TypeRef, next: TypeRef): TypeRef {
  return start.declaredSpelling === undefined
    ? { ...next, bindingRange: start.bindingRange }
    : { ...next, bindingRange: start.bindingRange, declaredSpelling: start.declaredSpelling };
}
