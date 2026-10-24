/**
 * Locks the eligible set of the scenario map (R1): the gate 1 envelope's accepted files that the
 * classifier still accepts, with the delta in both directions, and the `controls` mode that
 * enrols a fixture project's `*.case.ts` files without consulting the envelope.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  computeEligibility,
  ENVELOPE_FILE,
  parseEnvelopeFiles,
  resolveEligibility,
  type ClassifierVerdicts,
} from '../../../tools/scenario-map/inventory/eligible.js';

const A = 'test/unit/a.test.ts';
const B = 'test/unit/b.test.ts';
const C = 'test/unit/c.test.ts';
const D = 'test/unit/d.test.ts';
const FIXTURE = 'gitnexus/test/fixtures/mutation-scenario-map';

const verdicts: ClassifierVerdicts = {
  accepted: [A, C, D],
  rejected: [{ file: B, reasons: ['native package: tree-sitter'] }],
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
/** A temp repo root with the given repo-relative files. */
const tempRepo = (files: Record<string, string>): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'scenario-map-eligible-'));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return root;
};
const envelope = (files: string[]): string => JSON.stringify({ accepted: { files } });

describe('computeEligibility', () => {
  it('keeps the envelope files the classifier still accepts and reports the delta', () => {
    expect(computeEligibility([A, B, C], verdicts)).toEqual({
      mode: 'normal',
      files: [A, C],
      delta: {
        notValidated: [D],
        rejected: [{ file: B, reasons: ['native package: tree-sitter'] }],
      },
      extraRoots: [],
    });
  });

  it('reports an envelope file the classifier no longer sees as rejected, not found', () => {
    expect(computeEligibility([A, 'test/unit/gone.test.ts'], verdicts).delta?.rejected).toEqual([
      { file: 'test/unit/gone.test.ts', reasons: ['not found'] },
    ]);
  });
});

describe('parseEnvelopeFiles', () => {
  it('returns accepted.files', () => {
    expect(parseEnvelopeFiles({ accepted: { files: [B, A] } })).toEqual([B, A]);
  });

  it.each([
    ['no accepted section', {}],
    ['accepted.files that is not an array', { accepted: { files: 'a' } }],
    ['a non-string file', { accepted: { files: [1] } }],
    ['a duplicated file', { accepted: { files: [A, A] } }],
  ])('throws on %s', (_label, data) => {
    expect(() => parseEnvelopeFiles(data)).toThrow(/envelope/);
  });
});

describe('resolveEligibility', () => {
  it('normal mode reads the envelope and intersects it with the classifier', () => {
    const repoRoot = tempRepo({ [ENVELOPE_FILE]: envelope([A, B, C]) });
    const classifyTests = vi.fn((_root: string) => verdicts);
    expect(resolveEligibility({ repoRoot, mode: { kind: 'normal' }, classifyTests }).files).toEqual(
      [A, C],
    );
    expect(classifyTests).toHaveBeenCalledWith(repoRoot);
  });

  it('controls mode enrols the fixture case files and never consults the envelope', () => {
    const repoRoot = tempRepo({
      [`${FIXTURE}/rows.case.ts`]: '',
      [`${FIXTURE}/nested/pairs.case.ts`]: '',
      [`${FIXTURE}/src/rows.ts`]: '',
      [`${FIXTURE}/vitest.config.ts`]: '',
    });
    const classifyTests = vi.fn((_root: string) => verdicts);
    expect(
      resolveEligibility({
        repoRoot,
        mode: { kind: 'controls', fixtureRoot: FIXTURE },
        classifyTests,
      }),
    ).toEqual({
      mode: 'controls',
      files: [
        'test/fixtures/mutation-scenario-map/nested/pairs.case.ts',
        'test/fixtures/mutation-scenario-map/rows.case.ts',
      ],
      delta: null,
      extraRoots: [FIXTURE],
    });
    expect(classifyTests).not.toHaveBeenCalled();
  });

  it('controls mode rejects a fixture root outside the mutation fixtures', () => {
    const repoRoot = tempRepo({});
    expect(() =>
      resolveEligibility({ repoRoot, mode: { kind: 'controls', fixtureRoot: 'gitnexus/tools' } }),
    ).toThrow(/not a mutation fixture directory/);
  });
});
