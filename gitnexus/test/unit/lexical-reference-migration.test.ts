import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertGraphParity } from '../../bench/lexical-lookup/reference-migration.mjs';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'reference-migration-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const sourceId = 'Function:src/example.ts:caller';
const targetId = 'Function:src/example.ts:target';
const edge = (id: string, changes = {}) => ({
  id,
  type: 'CALLS',
  sourceId,
  targetId,
  confidence: 1,
  reason: 'direct',
  ...changes,
});
const prefix = `rel:CALLS:${sourceId}->${targetId}`;

function compare(
  before: object[],
  after: object[],
  text = 'foo().bar();',
  source = sourceId,
  file = 'src/example.ts',
  corrupt?: 'baseline-edges' | 'baseline-nodes' | 'candidate-edges' | 'candidate-nodes',
) {
  fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
  const nodes = [JSON.stringify({ id: source, properties: { filePath: file } })];
  const report = (name: string, rows: object[]) => {
    const graphRowsPath = path.join(root, `${name}.json`);
    const edges = rows.map((row) => JSON.stringify(row));
    fs.writeFileSync(graphRowsPath, JSON.stringify({ nodes, edges }));
    const digest = (values: string[]) => {
      const hash = createHash('sha256');
      for (const row of [...values].sort()) hash.update(row).update('\n');
      return { count: values.length, sha256: hash.digest('hex') };
    };
    return {
      graphRowsPath,
      graph: { nodes: digest(nodes), edges: digest(edges) },
    };
  };
  const baseline = report('before', before);
  const candidate = report('after', after);
  if (corrupt) {
    const [variant, part] = corrupt.split('-') as ['baseline' | 'candidate', 'edges' | 'nodes'];
    const filePath = (variant === 'baseline' ? baseline : candidate).graphRowsPath;
    const snapshot = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    snapshot[part][0] += ' ';
    fs.writeFileSync(filePath, JSON.stringify(snapshot));
  }
  assertGraphParity(baseline, candidate, root);
}

describe('lexical benchmark reference migration parity', () => {
  it('accepts a single migrated call even if another target shares its AST start', () => {
    expect(() => compare([edge(`${prefix}:1:0`)], [edge(`${prefix}:1:0:1:5`)])).not.toThrow();
  });
  it('checks the current source again after an incremental edit', () => {
    const before = [edge(`${prefix}:1:0`)];
    const after = [edge(`${prefix}:1:0:1:5`)];
    expect(() => compare(before, after, 'foo().bar();')).not.toThrow();
    expect(() => compare(before, after, 'not_a_call;')).toThrow(/not an expected AST site/);
  });
  it.each(['baseline-edges', 'baseline-nodes', 'candidate-edges', 'candidate-nodes'] as const)(
    'rejects a mismatched %s snapshot',
    (corrupt) => {
      expect(() =>
        compare(
          [edge(`${prefix}:1:0`)],
          [edge(`${prefix}:1:0:1:5`)],
          undefined,
          undefined,
          undefined,
          corrupt,
        ),
      ).toThrow(/snapshot does not match sample/);
    },
  );
  it.each([
    ['wrong endpoint', edge(`${prefix}:1:0:1:5`, { targetId: 'different' })],
    ['changed property', edge(`${prefix}:1:0:1:5`, { confidence: 0.5 })],
    ['invented end', edge(`${prefix}:1:0:1:4`)],
    ['outside source', edge(`${prefix}:1:0:1:999`)],
    ['unknown edge', edge(`${prefix}:1:1:1:5`)],
  ])('rejects %s', (_case, changed) => {
    expect(() => compare([edge(`${prefix}:1:0`)], [changed])).toThrow();
  });
  it('rejects duplicate spans and unapproved expansion', () => {
    const old = [edge(`${prefix}:1:0`)];
    const inner = edge(`${prefix}:1:0:1:5`);
    expect(() => compare(old, [inner, inner])).toThrow(/Duplicate candidate/);
    expect(() => compare(old, [inner, edge(`${prefix}:1:0:1:11`)])).toThrow(/Unexpected expanded/);
  });
  it.each([
    ['ACCESSES', ':read', 'thing.field;', 0, 11, 10],
    ['USES', '', 'type X = Foo;', 9, 12, 11],
  ])('checks %s against the appropriate AST site', (type, access, text, start, end, badEnd) => {
    const id = `rel:${type}:${sourceId}->${targetId}${access}:1:${start}`;
    const old = edge(id, { type });
    expect(() => compare([old], [edge(`${id}:1:${end}`, { type })], text)).not.toThrow();
    expect(() => compare([old], [edge(`${id}:1:${badEnd}`, { type })], text)).toThrow(
      /not an expected AST site/,
    );
  });
  it('requires exact equality when the baseline already uses full spans', () => {
    expect(() => compare([edge(`${prefix}:1:0:1:5`)], [edge(`${prefix}:1:0:1:11`)])).toThrow(
      /strict equality required/,
    );
  });
  it('requires all audited same-target nested calls even when only one survives', () => {
    const file = 'gitnexus/src/core/ingestion/pipeline.ts';
    const source = `Function:${file}:buildPhaseList`;
    const target =
      'Method:gitnexus/src/core/ingestion/pipeline-phases/registry.ts:PhaseRegistry.register#2';
    const id = `rel:CALLS:${source}->${target}:348:4`;
    const baseline = edge(id, { sourceId: source, targetId: target });
    const first = edge(`${id}:348:24`, { sourceId: source, targetId: target });
    const second = edge(`${id}:348:36`, { sourceId: source, targetId: target });
    const text = `${'\n'.repeat(347)}    registry.register(x).register(y).build();`;
    expect(() => compare([baseline], [first, second], text, source, file)).not.toThrow();
    expect(() => compare([baseline], [first], text, source, file)).toThrow(
      /Incomplete nested call spans/,
    );
    // Another migrated edge must not mask leaving an audited group collapsed.
    const other = edge(`rel:CALLS:${source}->other:348:4`, { sourceId: source, targetId: 'other' });
    const otherSpan = { ...other, id: `${other.id}:348:24` };
    expect(() => compare([baseline, other], [baseline, otherSpan], text, source, file)).toThrow(
      /did not migrate/,
    );
  });
});
