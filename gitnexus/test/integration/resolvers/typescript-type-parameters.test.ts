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
 * Measured before the fix on this fixture: `unwrap` produced TWO false edges
 * while `readResult` produced the one correct edge.
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
 * aliases, then consult them at the point `USES` is emitted.
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
});
