/**
 * The drift guard for the implicit-receiver twin lists (#2699 follow-up).
 *
 * TWO lists spell "this is an implicit receiver", in two packages:
 *
 *   - `IMPLICIT_RECEIVERS` — gitnexus-shared `lookup-core.ts`. Two consumers:
 *     the Step-1 lexical skip (a NAMED receiver must not resolve its member
 *     through the lexical chain) and `resolveReceiverOwner`.
 *   - `THIS_RECEIVERS` — gitnexus `type-env.ts`. Decides whether a receiver
 *     rewrites to the enclosing type.
 *
 * They are the SIXTH twin-list instance found in this family of work, and the
 * previous five each shipped a bug when one side moved. `$this` was added to
 * the shared list in #2714 precisely because it was already in the other one;
 * nothing but this test stops the next divergence.
 *
 * `Me` is the one deliberate asymmetry: `THIS_RECEIVERS` carries it (Visual
 * Basic spelling) and the shared list does not, because no entry in
 * `SupportedLanguages` uses it — mirroring it there could only ever exempt a
 * variable that happens to be named `Me`. That exemption is asserted
 * explicitly rather than tolerated, so RE-adding `Me` to the shared list, or
 * dropping it from the local one, both fail loudly.
 *
 * Structural (source-parsed) rather than value-imported: both constants are
 * module-private, and exporting them purely to be testable would widen two
 * public surfaces to satisfy a test. Same idiom as
 * `detect-changes-local-id-stability.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * String literals inside the first `[...]` following `marker` that actually
 * CONTAINS a string literal.
 *
 * "First `[`" is not good enough: `IMPLICIT_RECEIVERS` is declared
 * `: readonly string[] = Object.freeze([...])`, so the first bracket belongs to
 * the TYPE annotation and yields an empty list — which would make every
 * assertion below vacuously pass. That is exactly what the non-empty check in
 * the first test exists to catch, and it did.
 */
const literalsAfter = (source: string, marker: string): string[] => {
  const at = source.indexOf(marker);
  expect(at, `${marker} not found — update this test`).toBeGreaterThan(-1);
  for (let open = source.indexOf('[', at); open !== -1; open = source.indexOf('[', open + 1)) {
    const close = source.indexOf(']', open);
    if (close === -1) break;
    const names = [...source.slice(open + 1, close).matchAll(/'([^']*)'|"([^"]*)"/g)]
      .map((m) => m[1] ?? m[2] ?? '')
      .filter((s) => s.length > 0);
    if (names.length > 0) return names.sort();
  }
  return [];
};

const sharedList = (): string[] =>
  literalsAfter(
    readFileSync(
      path.join(
        __dirname,
        '../../../gitnexus-shared/src/scope-resolution/registries/lookup-core.ts',
      ),
      'utf-8',
    ),
    'const IMPLICIT_RECEIVERS',
  );

const typeEnvList = (): string[] =>
  literalsAfter(
    readFileSync(path.join(__dirname, '../../src/core/ingestion/type-env.ts'), 'utf-8'),
    'const THIS_RECEIVERS',
  );

describe('#2699 — implicit-receiver twin lists do not drift', () => {
  it('both lists are non-empty and were actually parsed', () => {
    // Guards the guard: a regex that silently matched nothing would make every
    // assertion below vacuously true.
    expect(sharedList().length).toBeGreaterThan(0);
    expect(typeEnvList().length).toBeGreaterThan(0);
  });

  it('the shared list is exactly the type-env list minus the deliberate `Me`', () => {
    expect(sharedList()).toEqual(typeEnvList().filter((name) => name !== 'Me'));
  });

  it('`Me` stays OUT of the shared list', () => {
    // Stated separately so the intent survives even if the set comparison above
    // is ever relaxed: this asymmetry is a decision, not an oversight.
    expect(sharedList()).not.toContain('Me');
  });

  it('`Me` stays IN the type-env list', () => {
    expect(typeEnvList()).toContain('Me');
  });
});
