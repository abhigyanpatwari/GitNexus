/**
 * A TYPE PARAMETER SHADOWS A DECLARED TYPE OF THE SAME NAME (W2-8).
 *
 * `export function unwrap<Result>(value: Result): Result` names the parameter,
 * not the `interface Result` beside it. The type-reference capture that makes a
 * contract answerable ("what breaks if I remove this field?") had no notion of a
 * parameter binding, so every annotation mentioning `Result` inside `unwrap`
 * minted a `USES` edge into the interface — at the same confidence as a real
 * consumer and indistinguishable from one.
 *
 * Measured on the first four declarations of `shapes.ts` before any of this:
 * `unwrap` produced TWO false edges while `readResult` produced the one correct
 * edge. Measured on the file as it stands now, with the first cut of the rule in
 * place and the two scope-less generic aliases added: ZERO edges, correct ones
 * included, across all four fixture files. See below.
 *
 * The blast radius is every generic whose parameter name collides with a
 * declared type — `Result`, `Key`, `Value`, `Item`, `Node`, `Options`, `Config`,
 * `Props`, `State`, `Response` are all ordinary choices for both.
 *
 * #2833 introduced `bindsTypeParameter` for the CALL-receiver path, where a
 * workspace `class T` was answering for `<T>`. It could not fix this one,
 * because `@declaration.type-parameters` was captured for class/interface
 * declarations only — a generic FUNCTION recorded no parameter list at all, so
 * the predicate correctly returned false ("absence is not evidence"). The fix is
 * therefore in two halves: capture the parameters on generic functions and
 * aliases, then consult them where a type reference is RESOLVED.
 *
 * ── WHY EVERY ARM BELOW EXISTS ────────────────────────────────────────────────
 *
 * OVER-SUPPRESSION IS THE EXPENSIVE DIRECTION and the reason the fixture grew.
 * A deleted edge answers "nothing uses this" for code that does, and nothing
 * anywhere reports that an edge was removed — so the only way to know is to
 * assert the edges that must SURVIVE, beside the ones that must not.
 *
 *   · `readResult` / `wrap` (shapes.ts) FAIL without the fix. `Maybe` and `Ids`
 *     are generic aliases whose value is not an object type, so they open no
 *     scope of their own and their parameter list is owned by the MODULE. Read
 *     there, `Result` is bound as a type parameter in EVERY scope in the file
 *     and the file loses ALL of its genuine `USES` edges — including the control
 *     declared above the aliases, and measured at zero remaining edges across
 *     the four files.
 *
 * The remaining arms PASS both with and without the fix and are labelled as such
 * on purpose. Each is a boundary the rule sits next to and must not creep
 * across, and each is only reachable today by an accident of routing that a
 * future change could remove:
 *
 *   · `useRow` (values.ts) — a `USES` edge is not always a type annotation:
 *     `type-reference`, `value-ref` (#2437) and `macro` (#1934) all map to it,
 *     and TypeScript keeps types and values in separate namespaces, so `<Item>`
 *     cannot shadow the FUNCTION `Item`. Value refs happen to be emitted by
 *     `emitPropertyDispatchCalls` rather than through the resolver, so a rule
 *     keyed on the emitted EDGE TYPE never reached them — but only by routing.
 *     Keyed on the reference KIND, as it now is, it cannot reach them at all.
 *   · `useAliased` (aliased.ts) — written `RowItem`, resolves to a def named
 *     `Item`. Only the written name can shadow, and it does not.
 *   · `hold` / `readInner` (namespaced.ts) — the shadowed reference and the
 *     genuine one, in the same namespace, so the absence means "suppressed"
 *     rather than "nothing resolved". A rule that recovers the name from the
 *     resolved graph id gets `hold` right only while TypeScript happens to key
 *     that node on the bare `Inner`; write the qualified `Host.Inner` there —
 *     as other languages do — and the false edge comes back.
 *
 * NOT PINNED HERE, deliberately: the alias-vs-resolved-name split on an imported
 * TYPE. TypeScript emits no cross-file `USES` edge for a type annotation at all
 * today — verified on this fixture both with and without a colliding parameter —
 * so an assertion on one would pass for the wrong reason in both directions.
 * `aliased.ts` therefore makes the point through an imported VALUE, which does
 * resolve across files.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

describe('TypeScript type-parameter shadowing (W2-8)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-type-parameters'), () => {});
  }, 60000);

  const usersOf = (typeName: string): string[] =>
    getRelationships(result, 'USES')
      .filter((e) => e.target === typeName)
      .map((e) => e.source);

  const reasonsFor = (targetName: string, sourceName: string): string[] =>
    getRelationships(result, 'USES')
      .filter((e) => e.target === targetName && e.source === sourceName)
      .map((e) => e.rel.reason);

  it('links a genuine consumer of the interface', () => {
    // Asserted FIRST: every absence below is vacuous if the rule stopped
    // emitting entirely, which is the obvious wrong way to "fix" this.
    expect(usersOf('Result')).toContain('readResult');
  });

  it('does not link a generic whose parameter shadows the type name', () => {
    expect(usersOf('Result')).not.toContain('unwrap');
  });

  it('does not link a generic type alias whose parameter shadows it', () => {
    expect(usersOf('Result')).not.toContain('Box');
  });

  it('still links a real reference inside a generic that does NOT collide', () => {
    // `wrap<T>` annotates `meta: Result`, which is the interface — the shadowing
    // rule must be keyed on the actual parameter names, not on "is generic".
    expect(usersOf('Result')).toContain('wrap');
  });

  it('keeps the whole file answerable when a generic alias opens no scope', () => {
    // `Maybe<Result>` / `Ids<Result>` are the alias forms that own no scope, so
    // their parameters are owned by the module. Both consumers above sit in that
    // same module and are the measurement: one un-anchored parameter list takes
    // every one of them out at once.
    expect(usersOf('Result').sort()).toEqual(['readResult', 'wrap']);
  });

  it('keeps a value reference whose name collides with an enclosing parameter', () => {
    // The type and value namespaces are separate — `<Item>` cannot shadow the
    // FUNCTION `Item`. The reason is asserted because it is the discriminator:
    // widen the rule to the emitted edge type and this same registration is the
    // first thing it deletes.
    expect(usersOf('Item')).toContain('useRow');
    expect(reasonsFor('Item', 'useRow')).toEqual(['scope-resolution: value-ref']);
  });

  it('keeps a reference written under an import alias inside a colliding generic', () => {
    // Written `RowItem`, resolves to a def named `Item`. Only the written name
    // can shadow, and it does not — so this survives whether the rule reads the
    // written name (it does) or is widened to reach value references (it must
    // not, and then this is what says so).
    expect(usersOf('Item')).toContain('useAliased');
  });

  it('links a genuine consumer declared inside a namespace', () => {
    // The control for the arm below — `Host.Inner` has to be reachable at all
    // before its absence from a generic can mean anything.
    expect(usersOf('Inner')).toContain('readInner');
  });

  it('drops the shadowed reference to a namespace-qualified type', () => {
    expect(usersOf('Inner')).not.toContain('hold');
  });
});
