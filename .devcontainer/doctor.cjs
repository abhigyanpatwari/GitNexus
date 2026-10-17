'use strict';
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { read, workerBudget } = require('./resources.cjs');

const root = path.resolve(process.argv[2] || '/workspace');
console.log(
  `[doctor] Node ${process.version}; ${os.availableParallelism()} available CPUs; suggested dev test workers ${workerBudget()}`,
);
for (const file of [
  '/sys/fs/cgroup/memory.max',
  '/sys/fs/cgroup/memory.current',
  '/sys/fs/cgroup/memory.events',
  '/sys/fs/cgroup/cpu.max',
  '/proc/pressure/memory',
  '/proc/pressure/io',
  '/proc/sys/fs/inotify/max_user_watches',
  '/proc/sys/fs/inotify/max_user_instances',
])
  console.log(`[doctor] ${file}: ${read(file)}`);
for (const [command, args] of [
  ['findmnt', ['-rn', '-T', root, '-o', 'FSTYPE,OPTIONS']],
  ['df', ['-h', root]],
  ['df', ['-i', root]],
  ['bash', ['-c', 'ulimit -n']],
]) {
  try {
    console.log(execFileSync(command, args, { encoding: 'utf8', timeout: 5000 }).trim());
  } catch {
    console.log(`[doctor] ${command}: unavailable`);
  }
}
try {
  require('./verify-git-hooks.cjs').verifyGitHooks(root);
  console.log('[doctor] Husky hooks verified');
} catch (error) {
  console.log(`[doctor] Husky: ${error.message}`);
}
