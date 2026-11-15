'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { workerBudget } = require('./resources.cjs');

const [target, ...args] = process.argv.slice(2);
if (!['core', 'web'].includes(target))
  throw new Error('Usage: node .devcontainer/dev-test.cjs core|web [Vitest arguments]');
const root = path.resolve(__dirname, '..', target === 'core' ? 'gitnexus' : 'gitnexus-web');
const workers = workerBudget();
console.log(`[dev-test] ${target}: ${workers} workers (override with GITNEXUS_DEV_TEST_WORKERS)`);
const result = spawnSync(
  process.execPath,
  [
    path.join(root, 'node_modules/vitest/vitest.mjs'),
    ...(args.includes('--watch') ? [] : ['run']),
    ...args,
    `--maxWorkers=${workers}`,
  ],
  { cwd: root, stdio: 'inherit' },
);
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
