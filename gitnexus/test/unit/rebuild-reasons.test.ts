import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  REBUILD_REASON_KEYS,
  RebuildReasonCollector,
  readStoredRebuildReasons,
  type RebuildReason,
  type RebuildReasonKey,
} from '../../src/core/rebuild-reasons.js';

const schema: RebuildReason = { key: 'schema-fingerprint', text: 'index schema changed (A → B)' };
const runner: RebuildReason = { key: 'runner-identity', text: 'analyzer runner identity changed' };
const actuator: RebuildReason = {
  key: 'spring-actuator',
  text: 'Spring Actuator runtime enrichment requested',
};
const escalation: RebuildReason = {
  key: 'escalated-full-write',
  text: 'incremental write escalated to a full write; re-run with --force if it fails',
  forcing: false,
};

describe('RebuildReasonCollector summary', () => {
  it('formats a single reason inline', () => {
    const collector = new RebuildReasonCollector();
    collector.add(schema);
    expect(collector.formatSummary()).toBe(`Full rebuild required: ${schema.text}`);
  });

  it('formats three reasons as one numbered block', () => {
    const collector = new RebuildReasonCollector();
    collector.add(schema);
    collector.add(runner);
    collector.add(actuator);
    expect(collector.formatSummary()).toBe(
      'Full rebuild required (3 reasons):\n' +
        `  1. ${schema.text}\n` +
        `  2. ${runner.text}\n` +
        `  3. ${actuator.text}`,
    );
    expect(collector.keys()).toEqual(['schema-fingerprint', 'runner-identity', 'spring-actuator']);
  });

  it('reports not forced and formats nothing when empty', () => {
    const collector = new RebuildReasonCollector();
    expect(collector.forced).toBe(false);
    expect(collector.keys()).toEqual([]);
    expect(collector.formatSummary()).toBeUndefined();
    expect(collector.formatFollowUp()).toBeUndefined();
  });

  it('merges the same key into one entry with the newest text, keeping its position', () => {
    const collector = new RebuildReasonCollector();
    collector.add({ key: 'content-retention', text: 'repair-fts retention force' });
    collector.add(schema);
    collector.add({ key: 'content-retention', text: 'content retention changed' });
    expect(collector.reasons()).toEqual([
      { key: 'content-retention', text: 'content retention changed' },
      schema,
    ]);
  });

  it('reports forced once any forcing reason is present', () => {
    const collector = new RebuildReasonCollector();
    collector.add(runner);
    expect(collector.forced).toBe(true);
  });

  it('does not claim a full rebuild in a follow-up that carries only non-forcing reasons', () => {
    const collector = new RebuildReasonCollector();
    collector.formatSummary();
    collector.add(escalation);
    const followUp = collector.formatFollowUp() ?? '';
    expect(followUp).toContain(escalation.text);
    expect(followUp).not.toMatch(/full rebuild/i);
  });

  it('lists a non-forcing reason without reporting forced', () => {
    const collector = new RebuildReasonCollector();
    collector.add(escalation);
    expect(collector.forced).toBe(false);
    expect(collector.keys()).toEqual(['escalated-full-write']);
    expect(collector.formatSummary()).toBe(`Full rebuild required: ${escalation.text}`);
  });
});

describe('RebuildReasonCollector follow-up', () => {
  it('formats two late reasons as one line covering only the unannounced ones', () => {
    const collector = new RebuildReasonCollector();
    collector.add(schema);
    collector.formatSummary();
    collector.add({ key: 'analysis-features', text: 'analysis capabilities changed' });
    collector.add(escalation);
    const followUp = collector.formatFollowUp();
    expect(followUp?.split('\n')).toHaveLength(1);
    expect(followUp).toContain('analysis capabilities changed');
    expect(followUp).toContain(escalation.text);
    expect(followUp).not.toContain(schema.text);
  });

  it('keeps a follow-up on one line when a late reason text spans lines', () => {
    const collector = new RebuildReasonCollector();
    collector.formatSummary();
    collector.add({ key: 'analysis-features', text: 'first line\nsecond line' });
    expect(collector.formatFollowUp()?.split('\n')).toHaveLength(1);
  });

  it('formats nothing when no reason arrived after the summary', () => {
    const collector = new RebuildReasonCollector();
    collector.add(schema);
    collector.formatSummary();
    expect(collector.formatFollowUp()).toBeUndefined();
  });

  it('does not repeat a follow-up once it was announced', () => {
    const collector = new RebuildReasonCollector();
    collector.formatSummary();
    collector.add(escalation);
    collector.formatFollowUp();
    expect(collector.formatFollowUp()).toBeUndefined();
  });

  it('treats a late re-add of an announced key as already announced', () => {
    const collector = new RebuildReasonCollector();
    collector.add(schema);
    collector.formatSummary();
    collector.add({ key: 'schema-fingerprint', text: 'index schema changed again' });
    expect(collector.formatFollowUp()).toBeUndefined();
  });
});

describe('RebuildReasonCollector interrupted-rebuild recovery', () => {
  it('names the interrupted rebuild and its stored reason in one forcing entry', () => {
    const collector = new RebuildReasonCollector();
    collector.recordInterruptedRebuild([schema], 'phase=load-graph');
    expect(collector.keys()).toEqual(['interrupted-rebuild']);
    expect(collector.forced).toBe(true);
    const text = collector.reasons()[0].text;
    expect(text).toContain('did not complete cleanly');
    expect(text).toContain('phase=load-graph');
    expect(text).toContain(schema.text);
  });

  it('merges a re-detected reason with a matching key into the entry', () => {
    const collector = new RebuildReasonCollector();
    collector.recordInterruptedRebuild([schema]);
    collector.add({ key: 'schema-fingerprint', text: 'index schema changed (B → C)' });
    collector.add(runner);
    const summary = collector.formatSummary() ?? '';
    expect(collector.keys()).toEqual(['interrupted-rebuild', 'runner-identity']);
    expect(summary.split('index schema changed')).toHaveLength(2);
    expect(summary).toContain('index schema changed (B → C)');
    expect(summary).not.toContain(schema.text);
  });

  it('does not re-announce the interrupted-rebuild entry when a matching reason merges after the summary', () => {
    const collector = new RebuildReasonCollector();
    collector.recordInterruptedRebuild([schema]);
    collector.formatSummary();
    collector.add({ key: 'schema-fingerprint', text: 'index schema changed (B → C)' });
    expect(collector.formatFollowUp()).toBeUndefined();
    expect(collector.toStored()).toEqual([
      { key: 'schema-fingerprint', text: 'index schema changed (B → C)' },
    ]);
  });

  it('absorbs a matching reason that was added before the recovery entry', () => {
    const collector = new RebuildReasonCollector();
    collector.add({ key: 'schema-fingerprint', text: 'index schema changed (B → C)' });
    collector.recordInterruptedRebuild([schema]);
    expect(collector.keys()).toEqual(['interrupted-rebuild']);
    expect(collector.reasons()[0].text).toContain('index schema changed (B → C)');
  });

  it('flattens stored reasons that already contain an interrupted-rebuild entry', () => {
    const collector = new RebuildReasonCollector();
    collector.recordInterruptedRebuild([
      { key: 'interrupted-rebuild', text: 'Previous analyze run did not complete cleanly' },
      schema,
    ]);
    const text = collector.reasons()[0].text;
    expect(text.split('did not complete cleanly')).toHaveLength(2);
    expect(collector.toStored()).toEqual([schema]);
  });

  it('describes a marker with no stored reasons as having no reasons recorded', () => {
    const collector = new RebuildReasonCollector();
    collector.recordInterruptedRebuild([]);
    expect(collector.reasons()[0].text).toContain('no reasons recorded');
    expect(collector.forced).toBe(true);
  });

  it('numbers each stored cause inside a multi-cause interrupted-rebuild entry', () => {
    const collector = new RebuildReasonCollector();
    collector.recordInterruptedRebuild([schema, { key: 'future-key', text: 'from a newer build' }]);
    expect(collector.reasons()[0].text).toContain(`(1) ${schema.text}; (2) from a newer build`);
  });

  it('persists the interrupted-rebuild reasons before reasons collected earlier in this run', () => {
    const collector = new RebuildReasonCollector();
    collector.add({ key: 'user-force', text: 'forced' });
    collector.recordInterruptedRebuild([schema]);
    expect(collector.toStored().map((r) => r.key)).toEqual(['schema-fingerprint', 'user-force']);
  });

  it('persists the flattened, merged reasons with no interrupted-rebuild entry', () => {
    const collector = new RebuildReasonCollector();
    collector.recordInterruptedRebuild([schema, { key: 'future-key', text: 'from a newer build' }]);
    collector.add({ key: 'schema-fingerprint', text: 'index schema changed (B → C)' });
    collector.add(escalation);
    expect(collector.toStored()).toEqual([
      { key: 'schema-fingerprint', text: 'index schema changed (B → C)' },
      { key: 'future-key', text: 'from a newer build' },
      { key: escalation.key, text: escalation.text },
    ]);
  });

  it('keeps flattening across two consecutive crashes', () => {
    const first = new RebuildReasonCollector();
    first.recordInterruptedRebuild([schema]);
    first.add(runner);
    const second = new RebuildReasonCollector();
    second.recordInterruptedRebuild(readStoredRebuildReasons(first.toStored()));
    expect(second.toStored()).toEqual([schema, runner]);
    expect(second.reasons()[0].text.split('did not complete cleanly')).toHaveLength(2);
  });
});

describe('readStoredRebuildReasons', () => {
  it('keeps entries with string key and text, including unknown keys', () => {
    expect(
      readStoredRebuildReasons([
        schema,
        { key: 'future-key', text: 'from a newer build' },
        { key: 7, text: 'bad key' },
        { key: 'runner-identity' },
        null,
        'loose string',
      ]),
    ).toEqual([
      { key: 'schema-fingerprint', text: schema.text },
      { key: 'future-key', text: 'from a newer build' },
    ]);
  });

  it('drops extra fields so the result is the serializable shape', () => {
    expect(readStoredRebuildReasons([{ ...escalation, extra: 1 }])).toEqual([
      { key: escalation.key, text: escalation.text },
    ]);
  });

  it.each([
    ['undefined', undefined],
    ['a boolean legacy marker', true],
    ['an object', { key: 'schema-fingerprint', text: 'x' }],
    ['a string', 'schema-fingerprint'],
  ])('reads %s as no reasons recorded', (_label, value) => {
    const stored = readStoredRebuildReasons(value);
    expect(stored).toEqual([]);
    const collector = new RebuildReasonCollector();
    collector.recordInterruptedRebuild(stored);
    expect(collector.reasons()[0].text).toContain('no reasons recorded');
  });

  it('keeps an unknown stored key text inside the recovery entry', () => {
    const collector = new RebuildReasonCollector();
    collector.recordInterruptedRebuild(
      readStoredRebuildReasons([{ key: 'future-key', text: 'from a newer build' }]),
    );
    expect(collector.reasons()[0].text).toContain('from a newer build');
  });
});

/**
 * R15 coverage table: every `RebuildReasonKey` paired with the test file that
 * drives it through `runFullAnalysis` and asserts the key. The exhaustiveness
 * check below fails `tsc` when a key is added to the union without a row here.
 */
const REBUILD_REASON_COVERAGE = [
  { key: 'user-force', file: 'test/unit/incremental-orchestration.test.ts' },
  { key: 'skills', file: 'test/unit/stream-graph-emit-force-ordering.test.ts' },
  { key: 'parse-cache-bypass', file: 'test/unit/incremental-orchestration.test.ts' },
  { key: 'drop-embeddings', file: 'test/unit/stream-graph-emit-force-ordering.test.ts' },
  { key: 'interrupted-rebuild', file: 'test/unit/incremental-orchestration.test.ts' },
  { key: 'private-graph-unavailable', file: 'test/integration/shared-store-analyze.test.ts' },
  { key: 'shared-store-missing-graph', file: 'test/integration/shared-store-analyze.test.ts' },
  {
    key: 'content-retention',
    file: 'test/integration/external-storage-content-retention.test.ts',
  },
  { key: 'pdg-mode', file: 'test/unit/pdg-mode-flip.test.ts' },
  { key: 'schema-fingerprint', file: 'test/unit/incremental-orchestration.test.ts' },
  { key: 'graph-write-collapse', file: 'test/unit/incremental-orchestration.test.ts' },
  { key: 'analysis-features', file: 'test/unit/incremental-orchestration.test.ts' },
  { key: 'spring-vendor-prefixes', file: 'test/unit/incremental-orchestration.test.ts' },
  { key: 'runner-identity', file: 'test/unit/incremental-orchestration.test.ts' },
  { key: 'cjk-segmentation', file: 'test/unit/incremental-orchestration.test.ts' },
  { key: 'embedding-dims', file: 'test/unit/embedding-dims-guard.test.ts' },
  { key: 'spring-actuator', file: 'test/unit/incremental-orchestration.test.ts' },
  { key: 'asyncapi', file: 'test/unit/incremental-orchestration.test.ts' },
  { key: 'escalated-full-write', file: 'test/unit/incremental-orchestration.test.ts' },
] as const satisfies readonly { readonly key: RebuildReasonKey; readonly file: string }[];

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('rebuild reason coverage table (R15)', () => {
  it('lists every key exactly once', () => {
    const keys: readonly RebuildReasonKey[] = REBUILD_REASON_COVERAGE.map(({ key }) => key);
    // Runtime check against the exported key list: CI does not type-check
    // test files, so a compile-time-only gate would never fire.
    expect([...keys].sort()).toEqual([...REBUILD_REASON_KEYS].sort());
    expect(new Set(keys).size).toBe(keys.length);
  });

  // The runtime check only proves each named driver file exists; the
  // behavior proof is the driver test itself, which runs runFullAnalysis and
  // asserts the returned key. Grepping the file for the key would pass on a
  // stale string, so it is deliberately not asserted here.
  it.each(REBUILD_REASON_COVERAGE)('$key is driven by $file', ({ file }) => {
    const absolute = path.join(packageRoot, file);
    expect(existsSync(absolute)).toBe(true);
  });
});
