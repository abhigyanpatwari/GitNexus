// Scenario-map controls fixture (Phase 1 U17), positive control `set-non-member`: two different
// values reach Set.prototype.has on a supported table, a table read the value-flow check must not
// veto. Expected: Repeat, strong evidence (expected.json).
import { describe, expect, it } from 'vitest';
import { isReservedWord } from './src/set-non-member.js';

describe('set-non-member', () => {
  it('rejects banana as a reserved word', () => {
    expect(isReservedWord('banana')).toBe(false);
  });

  it('rejects cherry as a reserved word', () => {
    expect(isReservedWord('cherry')).toBe(false);
  });
});
