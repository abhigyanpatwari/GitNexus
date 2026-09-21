/**
 * Build-free throughput + identity bench for tRPC identifier-mounted subrouters.
 *
 * Arms:
 *   - inline: `pN: publicProcedure.query(...)` inside one appRouter (control)
 *   - mount: same-file `const rNRouter = t.router({ list }); appRouter = { rN: rNRouter }`
 *     (the #3339 composition path)
 *   - chain: depth-N identifier mounts with a procedure at every level (the
 *     C# "concentrated namespace" analog — a remount walk is O(depth ×
 *     procedures); a once-built path table stays linear)
 *
 * Usage:
 *   node --import tsx bench/trpc-route-extractor/measure.mjs
 *   node --import tsx bench/trpc-route-extractor/measure.mjs --check
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTrpcRoutes } from '../../src/core/ingestion/route-extractors/trpc.ts';
import { minSample } from '../lib/identity-guard.mjs';
import { fingerprintIds, runBaselineCheck, runCountCheck } from '../lib/route-constant-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.resolve(__dirname, 'baselines.json');
const FILE = 'src/server/trpc/routers/app.ts';
const SMALL = 250;
const LARGE = 800;
const REPS = 15;
const WARMUP = 5;

function header() {
  return [
    "import { initTRPC } from '@trpc/server';",
    'const t = initTRPC.create();',
    'const publicProcedure = t.procedure;',
    '',
  ].join('\n');
}

function generateInline(procedureCount) {
  // Shape-equivalent ballast so widening_overhead compares compose cost, not
  // file length: each mount arm procedure is a `const rNRouter = t.router`.
  const pads = Array.from({ length: procedureCount }, (_, i) => `const _pad${i} = ${i};`).join(
    '\n',
  );
  const keys = Array.from(
    { length: procedureCount },
    (_, i) => `  p${i}: publicProcedure.query(() => null),`,
  ).join('\n');
  return `${header()}${pads}\nexport const appRouter = t.router({\n${keys}\n});\n`;
}

function generateMount(routerCount) {
  const routers = Array.from(
    { length: routerCount },
    (_, i) => `const r${i}Router = t.router({\n  list: publicProcedure.query(() => null),\n});\n`,
  ).join('');
  const mounts = Array.from({ length: routerCount }, (_, i) => `  r${i}: r${i}Router,`).join('\n');
  return `${header()}${routers}export const appRouter = t.router({\n${mounts}\n});\n`;
}

function generateChain(depth) {
  const parts = [header()];
  parts.push('const r0Router = t.router({\n  list: publicProcedure.query(() => null),\n});\n');
  for (let i = 1; i < depth; i++) {
    parts.push(
      `const r${i}Router = t.router({\n  n${i - 1}: r${i - 1}Router,\n  list: publicProcedure.query(() => null),\n});\n`,
    );
  }
  parts.push(`export const appRouter = t.router({\n  n${depth - 1}: r${depth - 1}Router,\n});\n`);
  return parts.join('');
}

const GENERATORS = {
  inline: generateInline,
  mount: generateMount,
  chain: generateChain,
};

function measure(mode, procedureCount) {
  const source = GENERATORS[mode](procedureCount);
  const { last, ms } = minSample(
    () => {
      const routes = extractTrpcRoutes(FILE, source);
      return routes.map((r) => `${r.httpMethod} ${r.routePath} ${r.methodName} ${r.lineNumber}`);
    },
    WARMUP,
    REPS,
  );
  return {
    procedures: procedureCount,
    ms,
    routes: last.length,
    fingerprint: fingerprintIds(last),
  };
}

function scalingRatio(large, small) {
  return Number((large.ms / small.ms / (LARGE / SMALL)).toFixed(3));
}

const report = {
  inline_small: measure('inline', SMALL),
  inline_large: measure('inline', LARGE),
  mount_small: measure('mount', SMALL),
  mount_large: measure('mount', LARGE),
  chain_small: measure('chain', SMALL),
  chain_large: measure('chain', LARGE),
};
report.scaling_ratio = scalingRatio(report.mount_large, report.mount_small);
report.chain_scaling_ratio = scalingRatio(report.chain_large, report.chain_small);
report.widening_overhead = Number(
  (report.mount_large.ms / Math.max(report.inline_large.ms, 0.001)).toFixed(3),
);
report.absolute_ms = report.mount_large.ms;
report.fingerprint = report.mount_large.fingerprint;

runCountCheck(report, 'routes', {
  inline_large: LARGE,
  mount_large: LARGE,
  chain_large: LARGE,
});

if (!process.argv.includes('--check')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

runBaselineCheck(report, BASELINE_PATH);
