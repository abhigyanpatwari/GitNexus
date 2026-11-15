/**
 * Locks the Layer 2 context of a test (U5, R5, design §2 "Context"): Layer 0's context hash is
 * reused unchanged (enclosing hooks, describe-level statements, wrapper-call arguments, reached
 * declarations), and only what Layer 0 keeps out of it is added: mock, spy and env setup inside
 * the body, and the test call's own options. Row values are inputs, so the rows of an `it.each`
 * call share one context.
 */
import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../tools/scenario-map/facet/context.js';
import { extractCases, type CaseRecord } from '../../../tools/test-dupes/test-dupes.js';

const FILE = 'gitnexus/test/unit/a.test.ts';
const recordsOf = (...lines: string[]): CaseRecord[] =>
  extractCases({ path: FILE, source: lines.join('\n') });
const IMPORTS = [`import * as m from '../../src/m.js';`];

/** The two records of a file holding the two given tests inside one describe. */
function pair(first: string, second: string): [CaseRecord, CaseRecord] {
  const records = recordsOf(...IMPORTS, `describe('d', () => {`, first, second, `});`);
  expect(records).toHaveLength(2);
  return [records[0], records[1]];
}

describe('contextOf: Layer 0 parts', () => {
  it('splits two tests that differ only in an afterEach body', () => {
    const records = recordsOf(
      ...IMPORTS,
      `describe('a', () => {`,
      `  afterEach(() => { m.reset(); });`,
      `  it('t', () => { expect(m.f()).toBe(1); });`,
      `});`,
      `describe('b', () => {`,
      `  afterEach(() => { m.clear(); });`,
      `  it('t', () => { expect(m.f()).toBe(1); });`,
      `});`,
    );
    const [a, b] = records.map(contextOf);
    expect(a.layer0).toBe(records[0].contextHash);
    expect(a.hash).not.toBe(b.hash);
  });

  it('shares the context of two tests under the same hooks whatever their bodies', () => {
    const records = recordsOf(
      ...IMPORTS,
      `describe('a', () => {`,
      `  afterEach(() => { m.reset(); });`,
      `  it('one', () => { expect(m.f()).toBe(1); });`,
      `  it('two', () => { expect(m.f()).toBe(2); });`,
      `});`,
    );
    expect(contextOf(records[0]).hash).toBe(contextOf(records[1]).hash);
  });

  it('shares the context of an it.each call and a plain test: row values are inputs', () => {
    const [each, plain] = pair(
      `it.each([[1], [2]])('row %i', (n) => { expect(m.f(n)).toBe(n); });`,
      `it('plain', () => { expect(m.f(1)).toBe(1); });`,
    );
    expect(each.each).not.toBeNull();
    expect(contextOf(each).hash).toBe(contextOf(plain).hash);
  });
});

describe('contextOf: parts Layer 0 keeps out of its context hash', () => {
  it.each([
    [
      'a vi.spyOn in the body',
      `it('a', () => { vi.spyOn(m, 'g'); expect(m.f()).toBe(1); });`,
      `it('b', () => { expect(m.f()).toBe(1); });`,
    ],
    [
      'a vi.stubEnv value in the body',
      `it('a', () => { vi.stubEnv('MODE', 'x'); expect(m.f()).toBe(1); });`,
      `it('b', () => { vi.stubEnv('MODE', 'y'); expect(m.f()).toBe(1); });`,
    ],
    [
      'an env write in the body',
      `it('a', () => { process.env.MODE = 'x'; expect(m.f()).toBe(1); });`,
      `it('b', () => { expect(m.f()).toBe(1); });`,
    ],
    [
      'the fails modifier',
      `it.fails('a', () => { expect(m.f()).toBe(1); });`,
      `it('b', () => { expect(m.f()).toBe(1); });`,
    ],
    [
      'a skipIf condition',
      `it.skipIf(m.flag)('a', () => { expect(m.f()).toBe(1); });`,
      `it('b', () => { expect(m.f()).toBe(1); });`,
    ],
    [
      'an options argument',
      `it('a', { retry: 2 }, () => { expect(m.f()).toBe(1); });`,
      `it('b', () => { expect(m.f()).toBe(1); });`,
    ],
  ])('splits two tests that differ only in %s', (_label, first, second) => {
    const [a, b] = pair(first, second);
    expect(a.contextHash).toBe(b.contextHash);
    expect(contextOf(a).hash).not.toBe(contextOf(b).hash);
  });

  it('records the body setup and the call options as exact code', () => {
    const [record] = recordsOf(
      ...IMPORTS,
      `it.concurrent.skipIf(m.flag)('t', { timeout: 5 }, () => {`,
      `  const spy = vi.spyOn(m, 'g');`,
      `  m.run();`,
      `  expect(spy).toHaveBeenCalled();`,
      `});`,
    );
    const context = contextOf(record);
    expect(context.bodySetup).toEqual([`const spy=vi.spyOn(m,'g');`]);
    expect(context.callOptions).toEqual([
      '.concurrent',
      '.skipIf',
      'mod:m.flag',
      'arg:{timeout:5}',
    ]);
  });

  it('keeps the each table out of the call options', () => {
    const [record] = recordsOf(
      ...IMPORTS,
      `it.concurrent.each([[1], [2]])('t %i', (n) => { expect(m.f(n)).toBe(1); });`,
    );
    expect(contextOf(record).callOptions).toEqual(['.concurrent']);
  });
});
