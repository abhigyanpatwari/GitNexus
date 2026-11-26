import { describe, expect, it } from 'vitest';
import type { NameClaim } from 'gitnexus-shared';
import {
  reconcilePythonImportClaims,
  type PythonImportClaim,
} from '../../../../src/core/ingestion/languages/python/import-claims.js';

function claim(name: string, extra: Partial<NameClaim> = {}): NameClaim {
  return {
    name,
    kind: 'binding',
    range: { startLine: 1, startCol: 0, endLine: 1, endCol: name.length },
    ...extra,
  };
}

describe('Python import-claim reconciliation', () => {
  it.each([32, 128, 512, 2048])('does linear claim work for %i distinct import names', (count) => {
    let nameReads = 0;
    let importClaimReads = 0;
    const claims = Array.from({ length: count }, (_, i) => ({
      ...claim(`name${i}`),
      get name() {
        nameReads++;
        return `name${i}`;
      },
    }));
    const imports = new Map<string, PythonImportClaim[]>(
      claims.map((item, i) => [
        `name${i}`,
        [
          {
            identity: `pkg.name${i}`,
            get claim() {
              importClaimReads++;
              return item;
            },
          },
        ],
      ]),
    );
    const result = reconcilePythonImportClaims(claims, imports, new Set());
    expect(result.map((item) => [item.name, item.kind, item.merge])).toEqual(
      Array.from({ length: count }, (_, i) => [`name${i}`, 'binding', true]),
    );
    expect(nameReads).toBeLessThanOrEqual(2 * count);
    expect(importClaimReads).toBe(count);
  });

  it.each([32, 128, 512, 2048])('does linear import work for %i repeated imports', (count) => {
    let identityReads = 0;
    let importClaimReads = 0;
    const claims = Array.from({ length: count }, () => claim('shared'));
    const imports = new Map([
      [
        'shared',
        claims.map((item) => ({
          get identity() {
            identityReads++;
            return 'pkg.shared';
          },
          get claim() {
            importClaimReads++;
            return item;
          },
        })),
      ],
    ]);
    const result = reconcilePythonImportClaims(claims, imports, new Set());
    expect(result).toHaveLength(count);
    expect(result.every((item) => item.kind === 'binding' && item.merge === true)).toBe(true);
    // The previous nested membership scan read import claims count * (count + 1) / 2 times.
    expect(importClaimReads).toBe(count);
    // The compatibility check compares each import's identity with the first one.
    expect(identityReads).toBeLessThanOrEqual(2 * count);
  });

  it('blocks conflicting imports but keeps a definite declaration and ordering', () => {
    const a = claim('shared');
    const b = claim('shared');
    const declaration = claim('shared', { hoisted: true });
    const unrelated = claim('other');
    const original = [a, unrelated, b, declaration];
    const result = reconcilePythonImportClaims(
      original,
      new Map([
        [
          'shared',
          [
            { identity: 'left.shared', claim: a },
            { identity: 'right.shared', claim: b },
          ],
        ],
      ]),
      new Set([declaration]),
    );
    expect(result).toEqual([
      { ...a, kind: 'blocked', competing: true },
      unrelated,
      { ...b, kind: 'blocked', competing: true },
      declaration,
    ]);
    expect(result[1]).toBe(unrelated);
    expect(result[3]).toBe(declaration);
    expect(original).toEqual([a, unrelated, b, declaration]);
    expect(a.kind).toBe('binding');
    expect(b.kind).toBe('binding');
  });

  it('merges compatible package imports while ignoring redirected claims', () => {
    const a = claim('pkg');
    const b = claim('pkg');
    const redirect = claim('pkg', { redirect: 'module', kind: 'blocked' });
    const result = reconcilePythonImportClaims(
      [a, redirect, b],
      new Map([
        [
          'pkg',
          [
            { identity: 'pkg.left', packageRoot: 'pkg', claim: a },
            { identity: 'pkg.right', packageRoot: 'pkg', claim: b },
          ],
        ],
      ]),
      new Set(),
    );
    expect(result).toEqual([{ ...a, merge: true }, redirect, { ...b, merge: true }]);
    expect(result[1]).toBe(redirect);
  });

  it('blocks an import mixed with a runtime store, including identical-looking claims', () => {
    const imported = claim('name');
    const store = claim('name');
    const result = reconcilePythonImportClaims(
      [imported, store],
      new Map([['name', [{ identity: 'pkg.name', claim: imported }]]]),
      new Set(),
    );
    expect(result).toEqual([
      { ...imported, kind: 'blocked', competing: true },
      { ...store, kind: 'blocked', competing: true },
    ]);
  });

  it('returns claims unchanged when there are no imports', () => {
    const original = [claim('local')];
    expect(reconcilePythonImportClaims(original, new Map(), new Set())).toBe(original);
  });
});
