import { describe, expect, it } from 'vitest';
import {
  selectedNodeDisplayLine,
  selectedNodeFileRange,
  selectedNodeLineHighlighted,
} from '../../src/components/code-panel-lines';

describe('selected-node GraphNode line math (0-based storage)', () => {
  it('requests /api/file starting at storedStart - context (not storedStart - 1 - context)', () => {
    // GraphNode startLine 99 is editor line 100. CONTEXT_LINES = 50.
    expect(selectedNodeFileRange(99, 99, 50)).toEqual({ startLine: 49, endLine: 149 });
  });

  it('highlights the 1-based display line for a 0-based node span', () => {
    expect(selectedNodeLineHighlighted(100, 99, 99)).toBe(true);
    expect(selectedNodeLineHighlighted(99, 99, 99)).toBe(false);
    expect(selectedNodeDisplayLine(99)).toBe(100);
  });

  it('still highlights a first-line symbol stored as startLine 0', () => {
    expect(selectedNodeLineHighlighted(1, 0, 0)).toBe(true);
    expect(selectedNodeDisplayLine(0)).toBe(1);
    expect(selectedNodeFileRange(0, 0, 50)).toEqual({ startLine: 0, endLine: 50 });
  });
});
