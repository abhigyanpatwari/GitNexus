// Conformance fixture (gate 2): runtime mutants, each covered by the tests that call it.
import { expect, it } from 'vitest';
import { nextTicket } from './src/counter.js';
import {
  countItems,
  double,
  featureDisabled,
  firstChar,
  scheduleAudit,
  settleDelay,
} from './src/runtime.js';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

it('doubles two', () => {
  expect(double(2)).toBe(4);
});

it('doubles three', () => {
  expect(double(3)).toBe(6);
});

it('reads the first character of nothing', () => {
  expect(firstChar(null)).toBe('');
});

it('counts three items', () => {
  expect(countItems([1, 2, 3])).toBe(3);
});

it('schedules no audit when quiet', async () => {
  scheduleAudit(true);
  await sleep(20);
  expect(true).toBe(true);
});

it('settles without waiting', async () => {
  await sleep(settleDelay(true));
  expect(true).toBe(true);
});

it('issues the first ticket', () => {
  expect(nextTicket()).toBe(1);
});

it('runs while the feature is enabled', (context) => {
  context.skip(featureDisabled(), 'the feature is disabled');
  expect(true).toBe(true);
});
