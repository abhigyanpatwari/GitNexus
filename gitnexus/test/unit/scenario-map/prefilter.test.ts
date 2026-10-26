/**
 * Locks the Layer 1 prefilter (tools/scenario-map/path-coverage/prefilter.ts): a file stays when a
 * test's checks-and-context key is shared, when its tests come from a helper or an alias the
 * inventory cannot see, when a call's instance count is not static, or when a body reads a file
 * snapshot; a file whose every test has a key no other test shares is skipped.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { layer1Files } from '../../../tools/scenario-map/path-coverage/prefilter.js';

const SOURCES: Record<string, string> = {
  'test/unit/shared.test.ts': [
    "import { add } from '../../src/add';",
    "it('adds one way', () => { expect(add(1, 2)).toBe(3); });",
    "it('adds the same way', () => { expect(add(1, 2)).toBe(3); });",
  ].join('\n'),
  'test/unit/unique.test.ts': [
    "import { mul } from '../../src/mul';",
    "it('multiplies', () => { expect(mul(2, 3)).toEqual([6]); });",
  ].join('\n'),
  'test/unit/helper.test.ts': [
    "import { defineCases } from '../helpers/cases';",
    "defineCases('rust');",
  ].join('\n'),
  'test/unit/dynamic.test.ts': [
    "import { rows } from '../helpers/rows';",
    "import { neg } from '../../src/neg';",
    "it.each(rows)('negates %s', (value) => { expect(neg(value)).toBeLessThan(1); });",
  ].join('\n'),
  'test/unit/alias.test.ts': [
    "import { sub } from '../../src/sub';",
    'const itSlow = it;',
    "describe('subtracts', () => {",
    "  it('once', () => { expect(sub(3, 1)).toBe(2); });",
    "  itSlow('twice', () => { expect(sub(sub(5, 1), 1)).toEqual(3); });",
    '});',
  ].join('\n'),
  'test/unit/snapshot.test.ts': [
    "import { render } from '../../src/render';",
    "it('renders', () => { expect(render()).toMatchSnapshot(); });",
  ].join('\n'),
};
const FILES = Object.keys(SOURCES);

describe('layer1Files', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'scenario-map-prefilter-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'gitnexus/test/unit'), { recursive: true });
  for (const [file, source] of Object.entries(SOURCES)) {
    writeFileSync(path.join(root, 'gitnexus', file), source);
  }

  it('skips only the file whose every test has a key no other test shares', () => {
    expect(layer1Files(root, FILES)).toEqual({
      files: [
        'test/unit/shared.test.ts',
        'test/unit/helper.test.ts',
        'test/unit/dynamic.test.ts',
        'test/unit/alias.test.ts',
        'test/unit/snapshot.test.ts',
      ],
      skipped: ['test/unit/unique.test.ts'],
    });
  });

  it('keeps a file whose key another file shares', () => {
    const twin = 'test/unit/twin.test.ts';
    writeFileSync(path.join(root, 'gitnexus', twin), SOURCES['test/unit/unique.test.ts']);
    expect(layer1Files(root, ['test/unit/unique.test.ts', twin]).skipped).toEqual([]);
  });
});
