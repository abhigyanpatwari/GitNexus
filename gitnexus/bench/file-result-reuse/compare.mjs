import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessComparison, phases, validatePair } from './check.mjs';

export async function compareRuntimes(options) {
  const count = Number(options.pairs ?? 7);
  const workers = Number(options.workers ?? 2);
  const files = Number(options.files ?? 1024);
  assert(
    Number.isSafeInteger(count) && count >= (options.check ? 7 : 1) && count <= 30,
    'Invalid --pairs (acceptance needs at least seven)',
  );
  assert(Number.isSafeInteger(workers) && workers >= 1 && workers <= 16, 'Invalid --workers');
  assert(
    Number.isSafeInteger(files) && files >= (options.check ? 1024 : 2),
    'Invalid --files (acceptance needs at least 1024)',
  );
  assert(options.output, 'Comparison requires --output');
  const output = path.resolve(options.output);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const runtimes = {
    baseline: path.resolve(options['baseline-dist']),
    candidate: path.resolve(options.dist ?? 'dist'),
  };
  for (const dist of Object.values(runtimes)) await fs.access(path.join(dist, 'cli/index.js'));
  const report = {
    schemaVersion: 2,
    measuredAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
      workers,
    },
    runtimes,
    warmup: null,
    pairs: [],
    verdict: 'incomplete',
  };
  const save = () => fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  const run = async (variant, iteration) => {
    const log = path.join(
      path.dirname(output),
      `${iteration < 0 ? 'warmup' : 'pair-' + iteration}-${variant}.log`,
    );
    const handle = await fs.open(log, 'w+');
    let outputText = '';
    try {
      const args = [
        fileURLToPath(new URL('./measure.mjs', import.meta.url)),
        '--dist',
        runtimes[variant],
        '--files',
        String(files),
        '--workers',
        String(workers),
      ];
      if (options.corpus) args.push('--corpus', path.resolve(options.corpus));
      const child = spawn(process.execPath, ['--max-old-space-size=4096', ...args], {
        stdio: ['ignore', handle.fd, handle.fd],
        env: { ...process.env, GITNEXUS_MEMORY: 'off' },
      });
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) =>
          code === 0
            ? resolve()
            : reject(new Error(`${variant} trial failed (${signal ?? code}); see ${log}`)),
        );
      });
      // Read the same log inode the child wrote, even if its path was replaced.
      for await (const chunk of handle.createReadStream({
        start: 0,
        autoClose: false,
        encoding: 'utf8',
      }))
        outputText += chunk;
    } finally {
      await handle.close();
    }
    const rows = outputText
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
      .filter((row) => row.kind === 'provenance' || phases.includes(row.kind));
    assert.equal(rows.length, phases.length + 1, `Incomplete trial: ${log}`);
    assert.equal(rows[0].kind, 'provenance', `Missing trial provenance: ${log}`);
    const trial = { provenance: rows[0], measurements: rows.slice(1) };
    assert.equal(
      trial.provenance.runtimeHead,
      execFileSync('git', ['-C', path.dirname(runtimes[variant]), 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
      'Measured wrong runtime revision',
    );
    if (options.check)
      assert(trial.provenance.sourceFiles >= 1024, 'Acceptance corpus needs at least 1024 files');
    return trial;
  };
  try {
    await save();
    for (let iteration = -1; iteration < count; iteration++) {
      const order = (iteration + 1) % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
      const pair = { iteration, order };
      if (iteration < 0) report.warmup = pair;
      else report.pairs.push(pair);
      for (const variant of order) {
        console.log(
          `${iteration < 0 ? 'Warmup' : 'Pair ' + (iteration + 1) + '/' + count}: ${variant}`,
        );
        pair[variant] = await run(variant, iteration);
        await save();
      }
      validatePair(pair);
    }
    if (count >= 7) {
      report.assessment = assessComparison(report);
      report.verdict = report.assessment.passed ? 'pass' : 'fail';
    } else report.verdict = 'smoke-only';
    await save();
  } catch (error) {
    report.verdict = 'invalid';
    report.error = error.message;
    await save();
    throw error;
  } finally {
    const metrics = report.assessment?.metrics ?? [];
    const summary =
      `## Per-file parse reuse: ${report.verdict}\n\nMode: ${report.assessment?.mode ?? 'incomplete/smoke-only'}. One excluded warmup and ${report.pairs.length} measured, alternating fresh-process pairs.\n\n| Metric | Unit | Base median | Candidate median | Paired ratio (95% interval) | Limit | Pass |\n| --- | --- | ---: | ---: | --- | ---: | --- |\n` +
      metrics
        .map(
          (m) =>
            `| ${m.name} | ${m.unit} | ${m.baselineMedianMs.toFixed(1)} | ${m.candidateMedianMs.toFixed(1)} | ${m.paired95.map((r) => r.toFixed(3)).join(' – ')} | ${m.limit} | ${m.passed} |`,
        )
        .join('\n') +
      `\n\nRepeated analyses sum warm, one edit, two edits, and repacking (including cache save). RSS is the process high-water mark, including parser worker threads; cache bytes are reported separately. Intervals crossing a budget fail. Graph equality and exact per-file reuse are required.\n${report.error ? '\nError: ' + report.error + '\n' : ''}`;
    await fs.writeFile(output.replace(/\.json$/, '') + '.md', summary);
    console.log(summary);
  }
  if (options.check && report.verdict !== 'pass') process.exitCode = 1;
}
