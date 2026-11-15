import type { ScopeId, TypeRef } from 'gitnexus-shared';

/** A qualified yield resolved to the class's OWN spelling, anchored at the
 *  module that declares it — see `AwaitedFollow.resolveQualified`. */
export interface QualifiedYield {
  readonly rawName: string;
  readonly declaredAtScope: ScopeId;
}

/** The `await` route of `ScopeResolver.elementTypeOf`, bound by the caller,
 *  plus the one thing a QUALIFIED yield needs that the route cannot give. */
export interface AwaitedFollow {
  /** What a declared type yields under `await`; `undefined` = not awaitable. */
  readonly yields: (declaredType: string) => string | undefined;
  /**
   * A qualified yield (`models.User`) names a class through the PRODUCER's
   * import — the module that wrote the return annotation — never through
   * the consumer's, whose same-named prefix may point at a different file.
   * Given the spelling and the producer's declaration scope, answer the
   * class's own spelling anchored at the module that declares it, or
   * `undefined`. Absent (the extractor sees no finalized imports) or
   * declining, the hop stays unanswered: no binding is better than one the
   * consumer's prefix map would decide.
   */
  readonly resolveQualified?: (
    spelling: string,
    producerScope: ScopeId,
  ) => QualifiedYield | undefined;
}

/**
 * One chain step: the binding takes the type the step reached, but keeps its
 * own written spelling when it has one. A spelling is evidence about THIS
 * binding — `member models.User`, normalized to `User`, can land on a sibling
 * field named `User` whose spelling is `api.User`, and a consumer reading the
 * spelling (a qualified lookup, an index step) must still see `models.User`.
 *
 * An AWAITED binding (`TypeRef.awaited`, `final x = await fetch()`) takes what
 * the reached type yields under `await` instead, when the caller hands in the
 * language's await route and the language answers: `Future<C>` → `C`. The
 * flag is cleared on that step — it describes the hop from the callee to its
 * awaited result, which this step has now taken — and the wrapper's spelling
 * is not carried, because it is container evidence about the callee's return,
 * not about this binding. When the language declines (awaiting a
 * non-awaitable yields the value itself), the step is the plain one above and
 * the flag stays.
 *
 * A QUALIFIED yield (`models.User`) is taken only through
 * `AwaitedFollow.resolveQualified`, which reads the qualifier in the
 * PRODUCER's scope and re-anchors the bare class name at the module that
 * declares it; the consumer then resolves a plain name at that anchor and its
 * own same-named prefix never enters.
 *
 * An UNANSWERED hop — no route at all, or a qualified yield with no resolver
 * (the extractor, before imports are finalized) or a declining one — leaves
 * the binding exactly as it was, callee name and flag: the plain step would
 * replace the callee with the wrapper spelling, and a later follow (the
 * post-finalize one, which can read the producer's import) must still find
 * the callee to redo the hop from. A binding that stays on its callee is a
 * missing edge; a binding stepped onto a wrapper it cannot unwrap is a typed
 * receiver that names no class and records nothing.
 */
export function followedStep(start: TypeRef, next: TypeRef, awaited?: AwaitedFollow): TypeRef {
  const plain: TypeRef =
    start.declaredSpelling === undefined
      ? { ...next, bindingRange: start.bindingRange }
      : { ...next, bindingRange: start.bindingRange, declaredSpelling: start.declaredSpelling };
  if (start.awaited !== true) return plain;
  if (awaited === undefined) return start;
  const yielded = awaited.yields(next.declaredSpelling ?? next.rawName);
  // Declined by the language: not an awaitable, so the value is the step itself.
  if (yielded === undefined) return { ...plain, awaited: true };
  const { declaredSpelling: _wrapper, awaited: _taken, ...rest } = plain;
  if (!yielded.includes('.')) return { ...rest, rawName: yielded };
  const resolved = awaited.resolveQualified?.(yielded, next.declaredAtScope);
  if (resolved === undefined) return start;
  // Anchored at the declaring module; the producer's lookup position is a
  // coordinate in a different file and must not filter claims there.
  const { lookupPosition: _producerPosition, ...anchored } = rest;
  return { ...anchored, rawName: resolved.rawName, declaredAtScope: resolved.declaredAtScope };
}
