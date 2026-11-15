'use strict';
const fs = require('node:fs');
const os = require('node:os');

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return 'unavailable';
  }
}

function workerBudget({
  memory = os.totalmem(),
  parallelism = os.availableParallelism(),
  memoryMax = read('/sys/fs/cgroup/memory.max'),
  cpuMax = read('/sys/fs/cgroup/cpu.max'),
  override = process.env.GITNEXUS_DEV_TEST_WORKERS,
} = {}) {
  if (override !== undefined && override !== '') {
    if (!/^[1-9][0-9]?$/.test(override))
      throw new Error('GITNEXUS_DEV_TEST_WORKERS must be an integer from 1 to 99');
    return Number(override);
  }
  if (/^[0-9]+$/.test(memoryMax)) memory = Math.min(memory, Number(memoryMax));
  const [quota, period] = cpuMax.split(' ').map(Number);
  if (Number.isFinite(quota) && quota > 0 && period > 0)
    parallelism = Math.min(parallelism, Math.max(1, Math.floor(quota / period)));
  // Leave room for the editor/API and native allocations outside Node's heap.
  return Math.max(1, Math.min(4, parallelism - 1, Math.floor(memory / 2 ** 30) - 1));
}

module.exports = { read, workerBudget };
