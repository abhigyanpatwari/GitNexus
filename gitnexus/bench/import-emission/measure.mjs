#!/usr/bin/env node
// Three fresh processes; checked-in correctness and allocation budgets stay read-only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const baselinePath = new URL('./baseline.json', import.meta.url);
const probePath = fileURLToPath(new URL('./probe.mts', import.meta.url));
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

export function checkSamples(samples, baseline) {
  assert.equal(samples.length, baseline.samples, 'Incomplete import-emission measurements');
  for (const [index, sample] of samples.entries()) {
    const label = `sample ${index + 1}`;
    for (const [key, expected] of Object.entries(baseline.workload))
      assert.equal(sample[key], expected, `${label}: workload ${key} differs`);
    for (const [key, expected] of Object.entries(baseline.correctness))
      assert.equal(sample[key], expected, `${label}: ${key} differs from baseline`);
    for (const key of ['inputHeap', 'firstEmitHeap', 'lastEmitHeap', 'afterHeap'])
      assert.ok(Number.isFinite(sample[key]) && sample[key] > 0, `${label}: invalid ${key}`);
    const delta = sample.firstEmitHeap - sample.inputHeap;
    assert.equal(sample.firstEmitHeapDeltaBytes, delta, `${label}: inconsistent heap delta`);
    assert.ok(
      delta <= baseline.budgets.maxFirstEmitHeapDeltaBytes,
      `${label}: first-emission heap growth ${delta} exceeds ${baseline.budgets.maxFirstEmitHeapDeltaBytes} bytes`,
    );
  }
}

function measure() {
  const { values } = parseArgs({
    options: {
      check: { type: 'boolean', default: false },
      output: { type: 'string', default: 'measure.json' },
      emitter: { type: 'string' },
    },
  });
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const output = path.resolve(values.output);
  assert.notEqual(output, fileURLToPath(baselinePath), '--output must not overwrite baseline.json');
  mkdirSync(path.dirname(output), { recursive: true });
  // Exclusive creation also protects existing files reached through symlinks.
  writeFileSync(output, '', { flag: 'wx' });
  const report = {
    schemaVersion: 1,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
    },
    workload: baseline.workload,
    budgets: baseline.budgets,
    samples: [],
    check: { requested: values.check, passed: null },
  };
  try {
    for (let trial = 0; trial < baseline.samples; trial++) {
      const args = [
        '--expose-gc',
        '--max-old-space-size=512',
        '--import',
        'tsx',
        probePath,
        '--files',
        String(baseline.workload.fileCount),
        '--imports',
        String(baseline.workload.importsPerFile),
        '--path-length',
        String(baseline.workload.pathLength),
      ];
      if (values.emitter) args.push('--emitter', path.resolve(values.emitter));
      const child = spawnSync(process.execPath, args, {
        cwd: packageRoot,
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      });
      if (child.error || child.status !== 0) {
        report.childFailure = {
          trial,
          status: child.status,
          signal: child.signal,
          stdout: child.stdout,
          stderr: child.stderr,
        };
        throw (
          child.error ??
          new Error(`Import-emission probe ${trial + 1} failed (${child.signal ?? child.status})`)
        );
      }
      report.samples.push(JSON.parse(child.stdout.trim()));
      writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    }
    if (values.check) {
      checkSamples(report.samples, baseline);
      report.check.passed = true;
    }
    console.log(
      `Import emission: ${report.samples.length} samples; ${values.check ? 'baseline check passed' : 'measurement only'}; ${output}`,
    );
  } catch (error) {
    report.check.passed = values.check ? false : null;
    report.error = error.message;
    throw error;
  } finally {
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    measure();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
