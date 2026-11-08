import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const harness = fileURLToPath(new URL('../../bench/lexical-lookup/measure.mjs', import.meta.url));
const scratch: string[] = [];
afterEach(() => {
  for (const root of scratch.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('lexical benchmark preflight', () => {
  it.each(['missing', 'empty-runtime', 'empty-output', 'lifecycle'])(
    'rejects %s arguments with a diagnostic before filesystem work',
    (kind) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexical-args-'));
      scratch.push(root);
      const args = [
        root,
        root,
        path.join(root, 'before'),
        path.join(root, 'after'),
        path.join(root, 'output'),
      ];
      if (kind === 'missing') args.pop();
      if (kind === 'empty-runtime') args[0] = '';
      if (kind === 'empty-output') args[4] = '';
      if (kind === 'lifecycle') args.push('warm');
      const result = spawnSync(process.execPath, [harness, ...args], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        kind === 'lifecycle'
          ? 'Lifecycle must be fresh or persistent; received "warm"'
          : 'Expected BASE_RUNTIME CANDIDATE_RUNTIME BASE_CORPUS CANDIDATE_CORPUS OUTPUT',
      );
      expect(fs.readdirSync(root)).toEqual([]);
    },
  );

  it.each([
    ['GITNEXUS_LEXICAL_BENCH_SCREEN', 'Screen must be 0 or 1'],
    ['GITNEXUS_LEXICAL_BENCH_BASE_FIRST', 'Base first must be 0 or 1'],
  ])('rejects invalid %s before touching corpora', (setting, message) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexical-option-'));
    scratch.push(root);
    const output = path.join(root, 'output');
    const result = spawnSync(process.execPath, [harness, root, root, root, root, output], {
      encoding: 'utf8',
      env: { ...process.env, [setting]: 'false' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(fs.existsSync(output)).toBe(false);
  });

  it.each(['empty', 'indexes', 'results.json'])(
    'rejects existing %s output before touching corpora',
    (contents) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexical-preflight-'));
      scratch.push(root);
      const output = path.join(root, 'output');
      fs.mkdirSync(output);
      if (contents === 'indexes') fs.mkdirSync(path.join(output, 'indexes'));
      if (contents === 'results.json')
        fs.writeFileSync(path.join(output, 'results.json'), 'prior result');
      const before = path.join(root, 'before');
      const after = path.join(root, 'after');
      const result = spawnSync(process.execPath, [harness, root, root, before, after, output], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITNEXUS_LEXICAL_BENCH_WORKER: '0',
          GITNEXUS_LEXICAL_BENCH_WORKERS: '2',
          GITNEXUS_LEXICAL_BENCH_HEAP_MIB: '4096',
        },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Output already exists');
      expect(fs.existsSync(before)).toBe(false);
      expect(fs.existsSync(after)).toBe(false);
      expect(fs.readdirSync(output)).toEqual(contents === 'empty' ? [] : [contents]);
      if (contents === 'results.json')
        expect(fs.readFileSync(path.join(output, contents), 'utf8')).toBe('prior result');
    },
  );
});

describe('lexical benchmark sample collection', () => {
  it.each([
    { lifecycle: 'fresh', pairArg: undefined, expectedPairs: 9 },
    { lifecycle: 'persistent', pairArg: undefined, expectedPairs: 9 },
    { lifecycle: 'fresh', pairArg: '3', expectedPairs: 3 },
    { lifecycle: 'persistent', pairArg: '3', expectedPairs: 3 },
  ])(
    'collects a complete reversed-order run with a slower candidate ($lifecycle, $expectedPairs pairs)',
    ({ lifecycle, pairArg, expectedPairs }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexical-samples-'));
      scratch.push(root);
      const corpora = ['before', 'after'].map((name) => {
        const repo = path.join(root, name);
        fs.mkdirSync(repo);
        execFileSync('git', ['init', '--quiet'], { cwd: repo });
        execFileSync(
          'git',
          [
            '-c',
            'user.name=Benchmark Test',
            '-c',
            'user.email=test@example.test',
            '-c',
            'commit.gpgsign=false',
            'commit',
            '--quiet',
            '--allow-empty',
            '-m',
            'fixture',
          ],
          {
            cwd: repo,
            env: {
              ...process.env,
              GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
              GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
            },
          },
        );
        return repo;
      });
      const runtimes = [1, 100].map((duration) => {
        const runtime = path.join(root, `runtime-${duration}`);
        const core = path.join(runtime, 'gitnexus/dist/core');
        fs.mkdirSync(path.join(core, 'lbug'), { recursive: true });
        fs.writeFileSync(path.join(runtime, 'package.json'), '{"type":"module"}');
        // A deterministic clock isolates collection/order behavior from machine load.
        fs.writeFileSync(
          path.join(core, 'run-analyze.js'),
          `
          import fs from 'node:fs';
          import path from 'node:path';
          let clock = 0;
          Object.defineProperty(globalThis, 'performance', {value: {now: () => clock}});
          export async function runFullAnalysis(repo) {
            clock += ${duration};
            const target = fs.readFileSync(path.join(repo, 'gitnexus/src/semantic-bench-control.ts'), 'utf8').includes('s.load()') ? 'load' : 'save';
            return {
              storagePath: repo, stats: {}, rebuildReasons: [],
              incrementalStats: {writeMode: 'incremental', changedFiles: 1},
              pipelineResult: {graph: {
                *iterNodes() { yield {id: 'semanticBenchUse', label: 'Function'}; },
                *iterRelationships() { yield {sourceId: 'semanticBenchUse', targetId: target, type: 'CALLS'}; }
              }}
            };
          }
        `,
        );
        fs.writeFileSync(path.join(core, 'logger.js'), 'export function configureLoggerSink() {}');
        fs.writeFileSync(
          path.join(core, 'lbug/lbug-adapter.js'),
          `
          import fs from 'node:fs';
          import path from 'node:path';
          let repo;
          export async function initLbug(db) { repo = path.dirname(db); }
          export async function executeQuery() {
            return [{target: fs.readFileSync(path.join(repo, 'gitnexus/src/semantic-bench-control.ts'), 'utf8').includes('s.load()') ? 'load' : 'save'}];
          }
          export async function closeLbug() {}
        `,
        );
        return runtime;
      });
      for (const screen of ['0', '1']) {
        const output = path.join(root, `output-${screen}`);
        const result = spawnSync(
          process.execPath,
          [harness, ...runtimes, ...corpora, output, lifecycle, ...(pairArg ? [pairArg] : [])],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              GITNEXUS_LEXICAL_BENCH_WORKER: '0',
              GITNEXUS_LEXICAL_BENCH_WORKERS: '2',
              GITNEXUS_LEXICAL_BENCH_HEAP_MIB: '256',
              GITNEXUS_LEXICAL_BENCH_SCREEN: screen,
              GITNEXUS_LEXICAL_BENCH_BASE_FIRST: '0',
            },
          },
        );
        expect(result.status, result.stderr).toBe(0);
        const report = JSON.parse(fs.readFileSync(path.join(output, 'results.json'), 'utf8'));
        expect(report.screen).toBe(screen === '1');
        expect(report.baseFirst).toBe(false);
        expect(report.pairs).toBe(expectedPairs);
        const order = [
          'candidate-seed',
          'baseline-seed',
          'candidate-1',
          'baseline-1',
          'baseline-2',
          'candidate-2',
          'candidate-3',
          'baseline-3',
          'baseline-4',
          'candidate-4',
          'candidate-5',
          'baseline-5',
          'baseline-6',
          'candidate-6',
          'candidate-7',
          'baseline-7',
          'baseline-8',
          'candidate-8',
          'candidate-9',
          'baseline-9',
        ];
        expect(report.results.map((sample: { name: string }) => sample.name)).toEqual(
          order.slice(0, screen === '0' ? 2 + 2 * expectedPairs : 4),
        );
        for (const repo of corpora)
          expect(fs.existsSync(path.join(repo, 'gitnexus/src/semantic-bench-control.ts'))).toBe(
            false,
          );
      }
    },
  );
});
