// Scenario-map controls fixture (Phase 1 U17), special pair `object-key-row` (design §5.4 row
// deletion, KTD10): two tests read two different keys of one three-key object-literal table.
// Deleting either key fails only the test that reads it. Expected: Row (expected.json).
import { describe, expect, it } from 'vitest';
import { toMillis } from './src/object-key-row.js';

describe('object-key-row', () => {
  it('converts seconds to milliseconds', () => {
    expect(toMillis(2, 's')).toBe(2000);
  });

  it('converts minutes to milliseconds', () => {
    expect(toMillis(2, 'min')).toBe(120000);
  });
});
