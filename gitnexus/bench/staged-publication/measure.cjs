#!/usr/bin/env node
/** Real forced rebuild + checkpoint/publication timing, with cold-reader oracles.
 * node --import tsx bench/staged-publication/measure.cjs [--check]
 * Run unchanged against base and candidate, each with its own built worker.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const { tmpdir } = os;
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

(async () => {
  const root = path.resolve(__dirname, '../..');
  const baseline = JSON.parse(await fs.readFile(path.join(__dirname, 'baseline.json'), 'utf8'));
  const environment = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0].model,
    filesystem: `0x${(await fs.statfs(tmpdir())).type.toString(16)}`,
  };
  const sameEnvironment = Object.entries(environment).every(
    ([key, value]) => baseline.environment?.[key] === value,
  );
  const scratch = await fs.mkdtemp(path.join(tmpdir(), 'gn-publication-bench-'));
  process.env.GITNEXUS_HOME = path.join(scratch, 'home');
  process.env.GITNEXUS_SHARED_STORE = 'off';
  process.env.GITNEXUS_WORKER_READY_TIMEOUT_MS = '60000';
  const options = {
    force: true,
    skipGit: true,
    skipFts: true,
    skipAgentsMd: true,
    skipSkills: true,
  };
  const results = [];
  try {
    const { runFullAnalysis } = await import(
      pathToFileURL(path.join(root, 'src/core/run-analyze.ts'))
    );
    for (const size of baseline.sizes) {
      const { files } = size;
      const repo = path.join(scratch, `repo-${files}`);
      await fs.mkdir(repo);
      const expected = [];
      for (let file = 0; file < files; file++) {
        const lines = [];
        for (let fn = 0; fn < baseline.functions_per_file; fn++) {
          const name = `fn_${file}_${fn}`;
          expected.push(name);
          lines.push(`export function ${name}(input: string) { return input.trim(); }`);
        }
        await fs.writeFile(path.join(repo, `file-${file}.ts`), lines.join('\n'));
      }
      expected.sort();
      const fingerprint = createHash('sha256').update(JSON.stringify(expected)).digest('hex');
      assert.equal(expected.length, size.functions);
      assert.equal(fingerprint, size.fingerprint);
      const samples = [];
      for (let trial = 0; trial <= baseline.timed_samples; trial++) {
        const started = performance.now();
        await runFullAnalysis(repo, options, { onProgress() {}, onLog() {} });
        const elapsed = performance.now() - started;
        if (trial > 0) samples.push(elapsed);
        // A different process has no writer or pool state to hide bad publication.
        const names = JSON.parse(
          execFileSync(
            process.execPath,
            [
              '-e',
              `
          const { Database, Connection } = require('@ladybugdb/core');
          (async () => {
            const db = new Database(process.argv[1], 64 * 1024 * 1024, false, true, 1024 ** 3);
            const conn = new Connection(db);
            const rows = await (await conn.query('MATCH (f:Function) RETURN f.name AS name')).getAll();
            console.log(JSON.stringify(rows.map(row => row.name).sort()));
            await conn.close(); await db.close();
          })().catch(error => { console.error(error); process.exitCode = 1; });
        `,
              path.join(repo, '.gitnexus/lbug'),
            ],
            { encoding: 'utf8', cwd: root },
          ),
        );
        assert.deepEqual(names, expected);
        assert.equal(
          (await fs.readdir(path.join(repo, '.gitnexus'))).some((entry) =>
            /^lbug\.(?:wal|shadow|checkpoint|staging)(?:\.|$)/.test(entry),
          ),
          false,
        );
      }
      samples.sort((a, b) => a - b);
      const median =
        (samples[Math.floor((samples.length - 1) / 2)] + samples[Math.floor(samples.length / 2)]) /
        2;
      results.push({
        files,
        functions: expected.length,
        median_ms: median,
        samples_ms: samples,
        fingerprint,
        baseline_ratio: median / size.median_ms,
      });
    }
    const scaling =
      results[1].median_ms / results[0].median_ms / (results[1].files / results[0].files);
    console.log(JSON.stringify({ environment, results, normalized_scaling: scaling }, null, 2));
    if (process.argv.includes('--check')) {
      assert.ok(scaling <= baseline.linear_scaling_budget);
      if (!sameEnvironment)
        console.warn(
          'Absolute timing gate skipped: baseline environment differs; correctness and scaling gates still apply.',
        );
      for (const result of results)
        if (sameEnvironment)
          assert.ok(
            result.baseline_ratio <= baseline.regression_budget,
            `publication regression: ${result.baseline_ratio}`,
          );
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
