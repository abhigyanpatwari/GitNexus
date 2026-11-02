// Conformance fixture (gate 2), retry scope: one test declares `retry: 1`.
import { expect, it } from 'vitest';
import { RETRY_POLICY, retryDelay } from './src/retry.js';

it('waits ten milliseconds per attempt', { retry: 1 }, () => {
  expect(retryDelay(2)).toBe(20);
});

it('uses the linear policy', () => {
  expect(RETRY_POLICY).toBe('linear');
});
