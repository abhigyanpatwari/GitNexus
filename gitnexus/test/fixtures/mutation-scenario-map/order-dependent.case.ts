// Scenario-map controls fixture (Phase 1 U17), special pair `order-dependent` (design §5.4 full
// isolation pass, KTD9): the second test relies on the counter the first test leaves behind. In
// file order both pass; run alone, the second gets `beta-1` and fails. The fingerprint sees
// different row values; mutation remains Inconclusive on isolation (expected.json).
import { describe, expect, it } from 'vitest';
import { nextTicketLabel } from './src/order-dependent.js';

describe('order-dependent', () => {
  it('labels the first ticket', () => {
    expect(nextTicketLabel('alpha')).toBe('alpha-1');
  });

  it('labels the second ticket', () => {
    expect(nextTicketLabel('beta')).toBe('beta-2');
  });
});
