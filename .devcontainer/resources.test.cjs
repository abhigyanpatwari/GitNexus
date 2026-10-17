'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { workerBudget } = require('./resources.cjs');

test('worker budget respects CPU quota, memory allowance and interactive headroom', () => {
  const limits = {
    memory: 32 * 2 ** 30,
    parallelism: 32,
    override: '',
    memoryMax: 'max',
    cpuMax: 'max 100000',
  };
  assert.equal(workerBudget(limits), 4);
  assert.equal(workerBudget({ ...limits, cpuMax: '200000 100000' }), 1);
  assert.equal(workerBudget({ ...limits, memoryMax: String(3 * 2 ** 30) }), 2);
  assert.equal(workerBudget({ ...limits, memoryMax: '100000000', cpuMax: '50000 100000' }), 1);
  assert.equal(workerBudget({ ...limits, memoryMax: 'unavailable', cpuMax: 'unavailable' }), 4);
});

test('worker override is explicit and validated', () => {
  assert.equal(workerBudget({ override: '2' }), 2);
  for (const override of ['0', '-1', 'abc', '1;bad', '100'])
    assert.throws(() => workerBudget({ override }), /integer/);
});
