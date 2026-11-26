import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

afterEach(() => vi.unstubAllEnvs());

async function analyze(
  budget: string | undefined,
  { extension = 'ts', reverse = false, duplicate = false, fanout = '32' } = {},
) {
  vi.resetModules();
  vi.stubEnv('GITNEXUS_MAX_PROPERTY_DISPATCH_EDGES_PER_KEY', budget);
  vi.stubEnv('GITNEXUS_MAX_PROPERTY_DISPATCH_FANOUT', fanout);
  const { runPipelineFromRepo, getRelationships, writeFixtureRepo } = await import('./helpers.js');
  const { _captureLogger } = await import('../../../src/core/logger.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-property-budget-'));
  const capture = _captureLogger();
  try {
    const files = {
      [`src/${reverse ? 'z' : 'a'}-registry.${extension}`]: `
export function first(callback) { callback(); }
export function second(callback) { callback(); }
export function other() {}
export const one = { run: first };
export const two = { run: second };
export const small = { go: other };
${duplicate ? 'export const alias = { run: first };' : ''}
`,
      [`src/m-calls.${extension}`]: `
export function task() {}
export function invoke(provider) {
  provider.run(task);
  provider.run(task);
  provider.run(task);
  provider.go();
}
`,
      [`src/plain.${extension}`]: `
export function stable() {}
export function callPlain() { stable(); }
`,
    };
    writeFixtureRepo(root, reverse ? Object.fromEntries(Object.entries(files).reverse()) : files);
    const result = await runPipelineFromRepo(root, () => {}, { workerPoolSize: 1 });
    return {
      calls: getRelationships(result, 'CALLS'),
      uses: getRelationships(result, 'USES'),
      records: capture.records(),
    };
  } finally {
    capture.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('property-dispatch candidate-pair budget (#3924)', () => {
  it('allows a one-pair key at the minimum positive budget', async () => {
    const { calls, records } = await analyze('1');
    expect(
      calls.filter((edge) => edge.rel.reason === 'property-dispatch').map((edge) => edge.target),
    ).toEqual(['other']);
    expect(records).toContainEqual(
      expect.objectContaining({
        skippedKeyNames: ['run'],
        skippedEdgePairs: 6,
        edgeBudget: 1,
      }),
    );
  }, 60000);

  it.each(['ts', 'js'])(
    'drops a whole over-budget key without affecting other calls (%s)',
    async (extension) => {
      // Three member sites and two distinct registrations: six pairs, not fanout overflow.
      const { calls, uses, records } = await analyze('5', { extension });
      expect(
        calls.filter((edge) => edge.rel.reason === 'property-dispatch').map((edge) => edge.target),
      ).toEqual(['other']);
      expect(calls.filter((edge) => edge.rel.reason === 'callable-value-flow')).toEqual([]);
      expect(
        calls.filter((edge) => edge.source === 'callPlain' && edge.target === 'stable'),
      ).toHaveLength(1);
      expect(
        uses
          .filter((edge) => edge.rel.reason === 'scope-resolution: value-ref')
          .map((edge) => edge.target)
          .sort(),
      ).toEqual(['first', 'other', 'second']);
      expect(records).toContainEqual(
        expect.objectContaining({
          skippedKeys: 1,
          skippedKeyNames: ['run'],
          skippedEdgePairs: 6,
          edgeBudget: 5,
        }),
      );
    },
    60000,
  );

  it.each(['6', '7'])(
    'preserves all calls at or below budget %s',
    async (budget) => {
      const { calls } = await analyze(budget);
      expect(
        calls
          .filter((edge) => edge.rel.reason === 'property-dispatch')
          .map((edge) => edge.target)
          .sort(),
      ).toEqual(['first', 'first', 'first', 'other', 'second', 'second', 'second']);
      expect(
        calls
          .filter((edge) => edge.rel.reason === 'callable-value-flow')
          .map((edge) => edge.target)
          .sort(),
      ).toEqual(['task', 'task']);
    },
    60000,
  );

  it('counts distinct targets rather than duplicate registrations', async () => {
    const { calls, uses } = await analyze('6', { duplicate: true });
    expect(
      calls
        .filter((edge) => edge.rel.reason === 'property-dispatch')
        .map((edge) => edge.target)
        .sort(),
    ).toEqual(['first', 'first', 'first', 'other', 'second', 'second', 'second']);
    expect(
      uses
        .filter((edge) => edge.rel.reason === 'scope-resolution: value-ref')
        .map((edge) => edge.target)
        .sort(),
    ).toEqual(['first', 'first', 'other', 'second']);
  }, 60000);

  it('makes the same whole-key decision when registration and call file order changes', async () => {
    const { calls, records } = await analyze('5', { reverse: true });
    expect(
      calls.filter((edge) => edge.rel.reason === 'property-dispatch').map((edge) => edge.target),
    ).toEqual(['other']);
    expect(records).toContainEqual(
      expect.objectContaining({
        skippedKeyNames: ['run'],
        skippedEdgePairs: 6,
      }),
    );
  }, 60000);

  it('keeps the existing registration-fanout cap when the pair budget allows the key', async () => {
    const { calls, records } = await analyze('100', { fanout: '1' });
    expect(
      calls.filter((edge) => edge.rel.reason === 'property-dispatch').map((edge) => edge.target),
    ).toEqual(['other']);
    expect(records).toContainEqual(
      expect.objectContaining({
        skippedKeys: 1,
        skippedKeyNames: ['run'],
        skippedEdgePairs: 6,
        fanoutCap: 1,
      }),
    );
  }, 60000);

  it.each([undefined, '', '0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992'])(
    'preserves existing dispatch when the budget is %s',
    async (budget) => {
      const { calls } = await analyze(budget);
      expect(
        calls
          .filter((edge) => edge.rel.reason === 'property-dispatch')
          .map((edge) => edge.target)
          .sort(),
      ).toEqual(['first', 'first', 'first', 'other', 'second', 'second', 'second']);
    },
    60000,
  );
});
