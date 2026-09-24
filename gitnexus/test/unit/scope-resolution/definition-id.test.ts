import { describe, expect, it } from 'vitest';
import { definitionIdPosition } from '../../../src/core/ingestion/scope-resolution/utils/definition-id.js';

describe('definitionIdPosition', () => {
  it('reads coordinates after a path containing a coordinate-like fragment (#2734)', () => {
    expect(
      definitionIdPosition(
        'def:src/bugs#12:34:test/a.php#4:2:Function:$handler',
        'src/bugs#12:34:test/a.php',
      ),
    ).toEqual({ line: 4, column: 2 });
  });

  it('does not mistake a private-name hash for the path separator', () => {
    expect(definitionIdPosition('def:src/a.ts#4:2:Method:#secret', 'src/a.ts')).toEqual({
      line: 4,
      column: 2,
    });
  });

  it.each<[string | undefined, string]>([
    [undefined, 'src/plain.php'],
    ['def:src/plain.php', 'src/plain.php'],
    ['def:src/plain.php#x:2:Function:handler', 'src/plain.php'],
    ['def:src/plain.php#4:x:Function:handler', 'src/plain.php'],
    ['def:src/other.php#4:2:Function:handler', 'src/plain.php'],
  ])('rejects malformed or mismatched definition id %s', (nodeId, filePath) => {
    expect(definitionIdPosition(nodeId, filePath)).toBeUndefined();
  });
});
