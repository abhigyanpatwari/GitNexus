// Scenario-map controls fixture (Phase 1 U17), adversarial pair `expected-only` (KTD11 test side):
// the same input from the describe's shared setup, asserted against two different expected
// values. Only the value-flow check separates the two tests. Expected: Review (expected.json).
import { describe, expect, it } from 'vitest';
import { formatTags } from './src/expected-only.js';

describe('expected-only', () => {
  const tags = ['alpha', 'beta'];

  it('renders the first tag', () => {
    expect(formatTags(tags)).toContain('alpha');
  });

  it('renders the second tag', () => {
    expect(formatTags(tags)).toContain('beta');
  });
});
