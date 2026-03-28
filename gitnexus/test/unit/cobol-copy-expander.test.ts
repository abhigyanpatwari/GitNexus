/**
 * Unit Tests: COBOL Copy Expander — pseudotext REPLACING support
 */
import { describe, it, expect } from 'vitest';
import { parseReplacingClause } from '../../src/core/ingestion/cobol/cobol-copy-expander.js';

describe('parseReplacingClause', () => {
  // Existing quoted-string behavior preserved
  it('parses quoted EXACT replacement', () => {
    const result = parseReplacingClause(' "OLD-NAME" BY "NEW-NAME" ');
    expect(result).toEqual([{ type: 'EXACT', from: 'OLD-NAME', to: 'NEW-NAME' }]);
  });

  it('parses LEADING replacement', () => {
    const result = parseReplacingClause(' LEADING "ESP-" BY "LK-ESP-" ');
    expect(result).toEqual([{ type: 'LEADING', from: 'ESP-', to: 'LK-ESP-' }]);
  });

  it('parses TRAILING replacement', () => {
    const result = parseReplacingClause(' TRAILING "-IN" BY "-OUT" ');
    expect(result).toEqual([{ type: 'TRAILING', from: '-IN', to: '-OUT' }]);
  });

  // Pseudotext ==...== support (isPseudotext flag propagated)
  it('parses basic pseudotext: ==OLD== BY ==NEW==', () => {
    const result = parseReplacingClause(' ==WS-OLD== BY ==WS-NEW== ');
    expect(result).toEqual([{ type: 'EXACT', from: 'WS-OLD', to: 'WS-NEW', isPseudotext: true }]);
  });

  it('parses empty pseudotext (deletion): ==TEXT== BY ====', () => {
    const result = parseReplacingClause(' ==REMOVE-ME== BY ==== ');
    expect(result).toEqual([{ type: 'EXACT', from: 'REMOVE-ME', to: '', isPseudotext: true }]);
  });

  it('parses pseudotext with spaces: ==SOME TEXT== BY ==OTHER TEXT==', () => {
    const result = parseReplacingClause(' ==WORKING STORAGE== BY ==LOCAL STORAGE== ');
    expect(result).toEqual([
      { type: 'EXACT', from: 'WORKING STORAGE', to: 'LOCAL STORAGE', isPseudotext: true },
    ]);
  });

  it('parses pseudotext with single = inside: ==A=B== BY ==C=D==', () => {
    const result = parseReplacingClause(' ==A=B== BY ==C=D== ');
    expect(result).toEqual([{ type: 'EXACT', from: 'A=B', to: 'C=D', isPseudotext: true }]);
  });

  it('parses mixed quoted + pseudotext in one clause', () => {
    const result = parseReplacingClause(' "OLD-NAME" BY "NEW-NAME" ==DEL-PREFIX== BY ==== ');
    expect(result).toEqual([
      { type: 'EXACT', from: 'OLD-NAME', to: 'NEW-NAME' },
      { type: 'EXACT', from: 'DEL-PREFIX', to: '', isPseudotext: true },
    ]);
  });

  it('LEADING modifier works alongside pseudotext', () => {
    const result = parseReplacingClause(
      ' LEADING "ESP-" BY "LK-ESP-" ==OLD-EXACT== BY ==NEW-EXACT== ',
    );
    expect(result).toEqual([
      { type: 'LEADING', from: 'ESP-', to: 'LK-ESP-' },
      { type: 'EXACT', from: 'OLD-EXACT', to: 'NEW-EXACT', isPseudotext: true },
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(parseReplacingClause('')).toEqual([]);
    expect(parseReplacingClause('   ')).toEqual([]);
  });
});
