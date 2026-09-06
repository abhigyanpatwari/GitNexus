#!/usr/bin/env node
/**
 * Build-free scaling and correctness guard for Zig cross-file static gates.
 *
 * The workspace pass parses every indexed Zig file, resolves direct @import
 * aliases, then applies sibling boolean constants to call sites. This bench
 * makes both relevant axes explicit: file count and calls per importer. It
 * also fingerprints the number of calls classified dead, so a fast no-op
 * implementation cannot pass the timing gate.
 *
 * Usage:
 *   node --import tsx bench/zig-cross-file-resolution/measure.mjs
 *   node --import tsx bench/zig-cross-file-resolution/measure.mjs --check
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { populateZigWorkspaceStaticGating } from '../../src/core/ingestion/languages/zig/workspace-static-gating.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SMALL_MODULES = 40;
const LARGE_MODULES = 160;
const CALLS_PER_MODULE = 12;
const REPS = 7;

const range = (line, col) => ({ startLine: line, startCol: col, endLine: line, endCol: col + 4 });

function corpus(modules) {
  const parsedFiles = [];
  const fileContents = new Map();
  for (let i = 0; i < modules; i++) {
    const cfgPath = `bench/cfg${i}.zig`;
    const appPath = `bench/app${i}.zig`;
    fileContents.set(cfgPath, 'pub const ENABLED = false;\n');
    fileContents.set(
      appPath,
      `const cfg = @import(\"./cfg${i}.zig\");\n` +
        Array.from(
          { length: CALLS_PER_MODULE },
          (_, j) => `pub fn run${j}() void { if (cfg.ENABLED) dead${j}(); }`,
        ).join('\n'),
    );
    parsedFiles.push(Object.freeze({ filePath: cfgPath, referenceSites: Object.freeze([]) }));
    parsedFiles.push(
      Object.freeze({
        filePath: appPath,
        referenceSites: Object.freeze(
          Array.from({ length: CALLS_PER_MODULE }, (_, j) => ({
            kind: 'call',
            name: `dead${j}`,
            atRange: range(j + 2, 44),
          })),
        ),
      }),
    );
  }
  return { parsedFiles, fileContents };
}

function run(modules) {
  const { parsedFiles, fileContents } = corpus(modules);
  populateZigWorkspaceStaticGating(parsedFiles, { fileContents });
  let gatedCalls = 0;
  for (const file of parsedFiles) {
    for (const site of file.referenceSites) if (site.staticGated === true) gatedCalls++;
  }
  return gatedCalls;
}

function measure(modules) {
  run(modules);
  let bestMs = Infinity;
  let gatedCalls = 0;
  for (let i = 0; i < REPS; i++) {
    const start = performance.now();
    gatedCalls = run(modules);
    bestMs = Math.min(bestMs, performance.now() - start);
  }
  return {
    modules,
    calls_per_module: CALLS_PER_MODULE,
    gated_calls: gatedCalls,
    min_ms: Number(bestMs.toFixed(2)),
  };
}

const report = { small: measure(SMALL_MODULES), large: measure(LARGE_MODULES) };
report.scaling_ratio = Number(
  (report.large.min_ms / Math.max(report.small.min_ms, 0.01)).toFixed(3),
);

if (!process.argv.includes('--check')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(join(HERE, 'baseline.json'), 'utf8'));
const failures = [];
for (const arm of ['small', 'large']) {
  for (const key of ['modules', 'calls_per_module', 'gated_calls']) {
    if (report[arm][key] !== baseline[arm][key]) {
      failures.push(`${arm}.${key}: expected ${baseline[arm][key]}, got ${report[arm][key]}`);
    }
  }
  if (report[arm].min_ms > baseline[arm].ms_budget) {
    failures.push(`${arm}.min_ms ${report[arm].min_ms} exceeds budget ${baseline[arm].ms_budget}`);
  }
}
if (report.scaling_ratio > baseline.scaling_ratio_budget) {
  failures.push(
    `scaling_ratio ${report.scaling_ratio} exceeds budget ${baseline.scaling_ratio_budget}`,
  );
}

console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) {
  console.error('[zig-cross-file-resolution --check] FAIL');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('[zig-cross-file-resolution --check] PASS');
