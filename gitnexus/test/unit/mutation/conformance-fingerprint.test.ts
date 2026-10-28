/**
 * Locks the input fingerprint of gate 2 conformance runs: `--compare-only` must refuse results
 * that an earlier run left behind once the runner, driver, prepare step, fixture or the installed
 * Stryker and Vitest changed. Pure functions only; the file walk is exercised by
 * `npm run test:mutation:conformance`.
 */
import { describe, expect, it } from 'vitest';
import {
  STALE_ARTEFACTS,
  fingerprintOf,
  isFingerprintInput,
  staleConformance,
} from '../../../tools/mutation/conformance/fingerprint.js';

const VERSIONS = { stryker: '10.0.0', vitest: '5.0.5' };
const FILES = {
  'tools/mutation/runner/plugin.ts': 'a'.repeat(64),
  'test/fixtures/mutation-conformance/src/rows.ts': 'b'.repeat(64),
};
const current = fingerprintOf(FILES, VERSIONS);

describe('isFingerprintInput', () => {
  it.each([
    ['the runner', 'tools/mutation/runner/plugin.ts', true],
    ['the driver', 'tools/mutation/driver/run-scope.ts', true],
    ['the prepare step', 'tools/mutation/prepare/prepare.ts', true],
    ['the shared helpers', 'tools/mutation/shared/fs.ts', true],
    ['the scope file reader', 'tools/mutation/scope-file.ts', true],
    ['the mutation Vitest config', 'tools/mutation/vitest.mutation.config.ts', true],
    ['a fixture case file', 'test/fixtures/mutation-conformance/rows.case.ts', true],
    ['a fixture production file', 'test/fixtures/mutation-conformance/src/rows.ts', true],
    ['the expected file', 'test/fixtures/mutation-conformance/expected.json', false],
    ['the comparison itself', 'tools/mutation/conformance/compare.ts', false],
    ['the oracle', 'tools/mutation/oracle/compare.ts', false],
    ['another fixture', 'test/fixtures/mutation-oracle/shared.json', false],
    ['a sibling with a shared prefix', 'tools/mutation/runner-notes/x.ts', false],
  ])('treats %s as %s', (_label, file, input) => {
    expect(isFingerprintInput(file)).toBe(input);
  });
});

describe('fingerprintOf', () => {
  it('does not depend on the order the files were listed in', () => {
    const reversed = Object.fromEntries(Object.entries(FILES).reverse());
    expect(fingerprintOf(reversed, VERSIONS).digest).toBe(current.digest);
  });

  it.each([
    ['a file content', { ...FILES, 'tools/mutation/runner/plugin.ts': 'c'.repeat(64) }, VERSIONS],
    ['a new file', { ...FILES, 'tools/mutation/driver/x.ts': 'd'.repeat(64) }, VERSIONS],
    ['the Stryker version', FILES, { ...VERSIONS, stryker: '10.1.0' }],
    ['the Vitest version', FILES, { ...VERSIONS, vitest: '5.1.0' }],
  ])('changes the digest with %s', (_label, files, versions) => {
    expect(fingerprintOf(files, versions).digest).not.toBe(current.digest);
  });
});

describe('staleConformance', () => {
  it('accepts a run recorded with the current inputs', () => {
    expect(staleConformance(JSON.parse(JSON.stringify(current)), current)).toBeNull();
  });

  it.each([
    ['no fingerprint', undefined, 'the run records no input fingerprint'],
    ['a malformed fingerprint', { digest: 1 }, 'the run records no input fingerprint'],
    [
      'a changed file',
      fingerprintOf({ ...FILES, 'tools/mutation/runner/plugin.ts': 'e'.repeat(64) }, VERSIONS),
      'changed since the run: tools/mutation/runner/plugin.ts',
    ],
    [
      'a file the run did not have',
      fingerprintOf({ 'tools/mutation/runner/plugin.ts': 'a'.repeat(64) }, VERSIONS),
      'changed since the run: test/fixtures/mutation-conformance/src/rows.ts',
    ],
    [
      'an older Stryker',
      fingerprintOf(FILES, { ...VERSIONS, stryker: '9.6.0' }),
      'Stryker 9.6.0 -> 10.0.0',
    ],
    [
      'a digest its own files do not produce',
      { ...current, digest: '0'.repeat(64) },
      'the recorded input digest does not match',
    ],
    [
      'edited files under the current digest',
      {
        ...fingerprintOf({ ...FILES, 'tools/mutation/shared/fs.ts': 'f'.repeat(64) }, VERSIONS),
        digest: current.digest,
      },
      'changed since the run: tools/mutation/shared/fs.ts',
    ],
  ])('reports stale artefacts for %s', (_label, recorded, detail) => {
    const message = staleConformance(recorded, current);
    expect(message).toContain(STALE_ARTEFACTS);
    expect(message).toContain(detail);
  });
});
