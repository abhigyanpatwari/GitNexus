import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import {
  mkdtempSync,
  mkdirSync,
  readFile,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { readFile as readAsync } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FixtureCapture } from '../../../tools/scenario-map/path-coverage/fixture-capture.js';
import { fixtureCapturePlugin } from '../../../tools/scenario-map/path-coverage/fixture-plugin.js';
import {
  CoverageAttributor,
  CoverageInterner,
  type RawCoverageRecord,
  type WindowDelta,
} from '../../../tools/scenario-map/path-coverage/records.js';
import {
  profileRuntimeFixtures,
  runtimeFixtureFor,
} from '../../../tools/scenario-map/facet/runtime-fixtures.js';
import { compareFixtureProfiles } from '../../../tools/scenario-map/facet/fixture-profile.js';
import { buildWorkFile } from '../../../tools/scenario-map/path-coverage/run-coverage.js';
import {
  mergeCoverageSlices,
  type CoverageSliceFile,
} from '../../../tools/scenario-map/path-coverage/slices.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const repo = (files: Record<string, string>) => {
  const root = mkdtempSync(path.join(tmpdir(), 'runtime-fixture-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
};
const delta = (fixtures: string[] = []): WindowDelta => ({
  blocks: new Set(),
  scripts: new Set(),
  natives: new Set(),
  spawns: [],
  fixtures,
});
const record = (capture: FixtureCapture): RawCoverageRecord => {
  const owner = new CoverageAttributor();
  owner.testStart('test', ['file'], false, delta());
  owner.testEnd('test', delta(capture.drain()));
  return {
    ...owner.record('/prep/gitnexus/test/input.test.ts', new CoverageInterner([], new Set())),
    fixtureSnapshots: capture.snapshots,
  };
};
const profile = async (raw: RawCoverageRecord, index = 0, concurrent = false) => {
  const result = runtimeFixtureFor(
    raw,
    raw.tests[index],
    (await profileRuntimeFixtures([raw])).get(raw),
    concurrent,
  );
  if (result === null) throw new Error('expected captured fixture');
  return result;
};
const TS = 'export function twice(x: number) { return x + x; }';
const PY = 'def twice(x):\n    return x + x\n';

it('does not capture a replacement installed after the file metadata check', () => {
  const root = repo({ 'main.ts': TS });
  const file = path.join(root, 'main.ts');
  const original = fs.lstatSync;
  let replaced = false;
  const stat = vi.spyOn(fs, 'lstatSync').mockImplementation(((...args) => {
    const result = Reflect.apply(original, fs, args);
    if (args[0] === file && !replaced) {
      replaced = true;
      fs.renameSync(file, `${file}.old`);
      writeFileSync(file, 'replacement contents must not be retained');
    }
    return result;
  }) as typeof fs.lstatSync);
  const capture = new FixtureCapture();
  try {
    capture.repository(root);
  } finally {
    stat.mockRestore();
  }
  expect(replaced).toBe(true);
  expect(JSON.stringify(capture.snapshots)).not.toContain('replacement contents');
  expect(Object.values(capture.snapshots)[0].unresolved.join()).toMatch(/changed|unreadable/);
});

it('bounds reads when a file grows after opening and closes the descriptor', () => {
  const root = repo({ 'main.ts': TS });
  const original = fs.fstatSync;
  let grew = false;
  const stat = vi.spyOn(fs, 'fstatSync').mockImplementation(((...args) => {
    const result = Reflect.apply(original, fs, args);
    if (!grew) {
      grew = true;
      fs.appendFileSync(path.join(root, 'main.ts'), 'x'.repeat(250_000));
    }
    return result;
  }) as typeof fs.fstatSync);
  const read = vi.spyOn(fs, 'readSync');
  const close = vi.spyOn(fs, 'closeSync');
  const capture = new FixtureCapture();
  try {
    capture.repository(root);
    expect(grew).toBe(true);
    expect(read.mock.results.reduce((n, result) => n + result.value, 0)).toBe(
      Buffer.byteLength(TS) + 1,
    );
    expect(close).toHaveBeenCalledOnce();
    expect(Object.values(capture.snapshots)[0]).toMatchObject({
      files: [],
      unresolved: ['main.ts: changed during capture'],
    });
  } finally {
    stat.mockRestore();
    read.mockRestore();
    close.mockRestore();
  }
});

it('closes the descriptor when reading fails and marks the snapshot incomplete', () => {
  const root = repo({ 'main.ts': TS });
  const read = vi.spyOn(fs, 'readSync').mockImplementation(() => {
    throw new Error('read failed');
  });
  const close = vi.spyOn(fs, 'closeSync');
  const capture = new FixtureCapture();
  try {
    capture.repository(root);
    expect(close).toHaveBeenCalledOnce();
    expect(Object.values(capture.snapshots)[0]).toMatchObject({
      files: [],
      unresolved: ['main.ts: unreadable'],
    });
  } finally {
    read.mockRestore();
    close.mockRestore();
  }
});

it('retains generated, deleted multilingual input contents and distinguishes control flow', async () => {
  const profiles = [];
  for (const files of [
    { 'main.ts': TS },
    { 'main.py': PY },
    { 'main.ts': 'export function twice(x: number) { while(x > 0) { x--; } return x; }' },
  ]) {
    const root = repo(files);
    const capture = new FixtureCapture();
    capture.repository(root);
    const raw = record(capture);
    rmSync(root, { recursive: true });
    profiles.push(await profile(JSON.parse(JSON.stringify(raw))));
  }
  expect(compareFixtureProfiles(profiles[0], profiles[1])).toMatchObject({
    kind: 'structure',
    crossLanguage: true,
  });
  expect(compareFixtureProfiles(profiles[0], profiles[2])).toBeNull();
  expect(profiles.map((p) => p.unresolved)).toEqual([[], [], []]);
  expect(profiles[0].contentKey).not.toBe(profiles[1].contentKey);
});

it('keeps input versions at the same path and ignores random temporary root names', async () => {
  const first = repo({ 'main.ts': TS });
  const second = repo({ 'main.ts': TS });
  const capture = new FixtureCapture();
  capture.repository(first);
  const a = record(capture);
  capture.repository(second);
  const b = record(capture);
  writeFileSync(path.join(first, 'main.ts'), TS.replace('x + x', 'x + 1'));
  capture.repository(first);
  const c = record(capture);
  expect((await profile(a)).contentKey).toBe((await profile(b)).contentKey);
  expect((await profile(a)).contentKey).not.toBe((await profile(c)).contentKey);
});

it('compares repeat inputs by content rather than temporary root names', async () => {
  const capture = new FixtureCapture();
  capture.repository(repo({ 'main.ts': TS }));
  const cold = capture.drain();
  capture.repository(repo({ 'main.ts': TS }));
  const raw = record(capture);
  raw.tests[0].all.fixtures = [...cold, ...(raw.tests[0].warm.fixtures ?? [])];
  expect((await profile(raw)).unresolved).toEqual([]);
  capture.repository(repo({ 'main.ts': TS.replace('x + x', 'x + 1') }));
  raw.tests[0].all.fixtures.push(...capture.drain());
  expect((await profile(raw)).unresolved).toContain(
    'runtime fixture inputs changed between attempts',
  );
});

it('filters module loading and production housekeeping from direct-read capture', () => {
  const capture = new FixtureCapture();
  expect(
    capture.accepts(
      'Error\n at read (/repo/tools/scenario-map/path-coverage/fixture-capture.ts:1:1)\n at helper (/repo/test/helpers/fixture.ts:8:1)',
    ),
  ).toBe(true);
  expect(
    capture.accepts(
      'Error\n at load (/repo/src/core/parser-loader.ts:8:1)\n at test (/repo/test/example.ts:9:1)',
    ),
  ).toBe(false);
  expect(capture.accepts('Error\n at load (/repo/node_modules/vite/test.js:8:1)')).toBe(false);
});

it('marks bounded captures incomplete instead of hashing a truncated repository as complete', async () => {
  const root = repo(
    Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`file${i}.txt`, 'sample'])),
  );
  const capture = new FixtureCapture();
  capture.repository(root);
  const p = await profile(record(capture));
  expect(p.contentKey).toBeNull();
  expect(p.unresolved).toContain('runtime repository capture limit');
  expect(p.files.length).toBeLessThanOrEqual(200);
});

it('bounds large returned buffers before allocating a decoded copy', () => {
  const capture = new FixtureCapture();
  const buffer = Buffer.alloc(200_000);
  buffer.toString = () => {
    throw new Error('must not decode oversized input');
  };
  expect(() => capture.read('/tmp/large.ts', buffer)).not.toThrow();
  expect(Object.values(capture.snapshots)).toMatchObject([
    { files: [], unresolved: ['oversized text'] },
  ]);
});

it('captures real sync, promise, callback and URL reads without changing results or errors', async () => {
  const root = repo({ 'main.ts': TS });
  const file = path.join(root, 'main.ts');
  const capture = new FixtureCapture();
  const restore = capture.install();
  try {
    expect(readFileSync(file, 'utf8')).toBe(TS);
    expect((await readAsync(pathToFileURL(file))).toString()).toBe(TS);
    expect(
      await new Promise((resolve, reject) =>
        readFile(file, 'utf8', (error, text) => (error ? reject(error) : resolve(text))),
      ),
    ).toBe(TS);
    expect(() => readFileSync(path.join(root, 'missing.ts'))).toThrow();
    await expect(readAsync(path.join(root, 'missing.ts'))).rejects.toThrow();
  } finally {
    restore();
  }
  const p = await profile(record(capture));
  expect(p.languages).toEqual(['typescript']);
  expect(p.files).toEqual([file]);
  expect(p.contentKey).toBeNull();
  expect(p.unresolved).toContain('test read may be assertion output; input role is unverified');
});

it('does not turn an identical generated output into proof of identical fixture inputs', async () => {
  const capture = new FixtureCapture();
  capture.read(
    '/tmp/setup-home/.claude.json',
    '{"mcpServers":{"gitnexus":{"command":"gitnexus.cmd"}}}',
  );
  const p = await profile(record(capture));
  expect(p.contentKey).toBeNull();
  expect(p.unresolved).toContain('test read may be assertion output; input role is unverified');
  // Keep the read available for diagnosis without promoting it to an ingestion input.
  expect(p.files).toEqual(['/tmp/setup-home/.claude.json']);
});

it('reports excluded, missing, oversized and symbolic inputs without leaking contents', async () => {
  const root = repo({
    '.env': 'never-retain-this',
    'large.ts': 'x'.repeat(200_000),
    'main.ts': TS,
  });
  if (process.platform !== 'win32')
    symlinkSync(path.join(root, 'main.ts'), path.join(root, 'alias.ts'));
  const capture = new FixtureCapture();
  capture.repository(root);
  capture.repository(path.join(root, 'missing'));
  const raw = record(capture);
  expect(JSON.stringify(raw)).not.toContain('never-retain-this');
  const p = await profile(raw);
  expect(p.contentKey).toBeNull();
  expect(p.unresolved.join()).toMatch(/environment/);
  expect(p.unresolved.join()).toMatch(/size limit/);
  if (process.platform !== 'win32') expect(p.unresolved.join()).toMatch(/symbolic/);
  expect(p.unresolved.join()).toMatch(/unreadable/);
});

it('attributes nested setup to its suite and retains warm-attempt and concurrent gaps', async () => {
  const capture = new FixtureCapture();
  const attributor = new CoverageAttributor();
  const inner = repo({ 'main.ts': TS });
  capture.inSuite('inner', () => capture.repository(inner));
  attributor.testStart('a', ['file', 'outer', 'inner'], false, delta(capture.drain()));
  attributor.testEnd('a', delta());
  attributor.testStart('b', ['file', 'outer'], false, delta());
  attributor.testEnd('b', delta());
  const raw = {
    ...attributor.record('/prep/gitnexus/test/input.test.ts', new CoverageInterner([], new Set())),
    fixtureSnapshots: capture.snapshots,
  };
  expect((await profile(raw)).unresolved).toEqual([]);
  expect(runtimeFixtureFor(raw, raw.tests[1], undefined, false)).toBeNull();
  expect((await profile(raw, 0, true)).contentKey).toBeNull();
  const profiles = await profileRuntimeFixtures([raw]);
  const work = buildWorkFile({
    mode: { kind: 'normal' },
    preparedRoot: '/prep',
    repeats: 1,
    unhandledErrors: [],
    raws: [raw],
    fixtureProfiles: profiles,
    modules: [
      {
        file: 'test/input.test.ts',
        errors: [],
        tests: raw.tests.map((t) => ({
          taskId: t.taskId,
          fullName: t.taskId,
          location: undefined,
          concurrent: false,
          state: 'passed',
        })),
      },
    ],
  });
  expect(work.tests[0].runtimeFixture?.languages).toEqual(['typescript']);
  expect(work.tests[1].runtimeFixture).toBeNull();
  raw.tests[0].all.fixtures = ['missing'];
  expect((await profile(raw)).unresolved.join()).toContain('changed between attempts');
});

it('leaves old records compatible and refuses missing snapshot evidence', async () => {
  const capture = new FixtureCapture();
  capture.repository(repo({ 'main.ts': TS }));
  const raw = record(capture);
  expect(runtimeFixtureFor(raw, raw.tests[0], undefined, false)?.contentKey).toBeNull();
  delete raw.fixtureSnapshots;
  expect(runtimeFixtureFor(raw, raw.tests[0], undefined, false)).toBeNull();
});

it('preserves capture versions and rejects mixed instrumented and archived coverage slices', () => {
  const slice = (index: number, captured: boolean): CoverageSliceFile => ({
    schemaVersion: 1,
    index,
    of: 2,
    layer1: [],
    mutation: 'none',
    changed: null,
    revision: null,
    work: {
      schemaVersion: 1,
      ...(captured ? { fixtureCaptureVersion: 1 } : {}),
      mode: 'normal',
      extraRoots: [],
      repeats: 1,
      blocks: [],
      files: [],
      tests: [],
      unhandledErrors: [],
    },
  });
  expect(
    mergeCoverageSlices([[], []], [slice(0, true), slice(1, true)]).fixtureCaptureVersion,
  ).toBe(1);
  expect(
    mergeCoverageSlices([[], []], [slice(0, false), slice(1, false)]).fixtureCaptureVersion,
  ).toBeUndefined();
  expect(() => mergeCoverageSlices([[], []], [slice(0, true), slice(1, false)])).toThrow(
    'not the run',
  );
});

it('instruments the pipeline entry with a source map and rejects entry point drift', async () => {
  const plugin = fixtureCapturePlugin('/prep/src/core/ingestion/pipeline.ts');
  const transform = plugin.transform;
  if (typeof transform !== 'function') throw new Error('missing transform');
  const result = await Reflect.apply(transform, {}, [
    'export const runPipelineFromRepo = async (root: string) => { return root; };',
    '/prep/src/core/ingestion/pipeline.ts',
  ]);
  expect(result.code).toContain('globalThis["__gitnexusScenarioFixtureCapture"]?.(root)');
  expect(JSON.parse(result.map).sources).toEqual(['/prep/src/core/ingestion/pipeline.ts']);
  expect(() =>
    Reflect.apply(transform, {}, [
      'export const changed = 1;',
      '/prep/src/core/ingestion/pipeline.ts',
    ]),
  ).toThrow('entry point');
});
